import {
  ALLOWED_MODELS,
  ALLOWED_REASONING_EFFORTS,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYSTEM_PROMPT,
  AI_TIMEOUT_MS,
  ATTACHMENT_TIMEOUT_MS,
  MAX_QUERY_CHARS,
  MAX_REPLY_CHARS,
  MAX_RESERVATION_NANO_USD,
  MAX_SYSTEM_PROMPT_CHARS,
  MAX_OUTPUT_TOKENS,
  type DeepSeekModel,
  type ReasoningEffort,
} from "../config";
import type { AIClient } from "../ai/deepseek";
import { actualRequestCost, estimateMaxRequestCost } from "../ai/pricing";
import type { AttachmentLoader, LoadedAttachment } from "../files/attachments";
import type { DSConfigField } from "./router";
import { UNKNOWN_COMMAND_REPLY } from "./router";
import { AppError, DeepSeekError } from "../errors";
import type { GroupAtMessageEvent } from "../qq/schema";
import { canManageGroup } from "../security/permissions";
import type {
  EventGuard,
  GlobalBudget,
  ReservationResult,
} from "../security/ratelimit";
import type {
  ConfigRepository,
  GroupConfig,
  GroupConfigChanges,
} from "../storage/config";
import { truncateText } from "../util";

export interface DSCommandDependencies {
  configRepository: ConfigRepository;
  eventGuard: EventGuard;
  globalBudget: GlobalBudget;
  aiClient: AIClient;
  attachmentLoader: AttachmentLoader;
  adminWhitelist: ReadonlyMap<string, ReadonlySet<string>>;
  groupLimitPerMinute: number;
  memberCooldownSeconds: number;
  onSettlementError?: (error: unknown) => void;
}

const PERMISSION_DENIED_REPLY =
  "权限不足：只有群主、群管理员或白名单成员可以管理本群配置。";

function deniedReply(
  result: ReservationResult,
  groupLimitPerMinute: number,
  memberCooldownSeconds: number,
): string {
  if (result.reason === "member_cooldown") {
    return `请求过于频繁：每人 ${memberCooldownSeconds} 秒内最多发起 1 次 AI 提问，请稍后再试。`;
  }
  if (result.reason === "group_budget") {
    return "本群今日 AI 额度已用完，请稍后再试。";
  }
  return `请求过于频繁：本群每分钟最多 ${groupLimitPerMinute} 次 AI 提问，请稍后再试。`;
}

function upstreamFailureReply(error: unknown): string {
  if (error instanceof DeepSeekError) {
    if (error.code === "budget_exhausted") {
      return "AI 服务额度不足，请联系管理员。";
    }
    if (error.code === "configuration") {
      return "AI 服务尚未配置，请联系管理员。";
    }
    if (error.code === "response_empty" || error.code === "invalid_request") {
      return "AI 未返回有效回答，请调整问题后重试。";
    }
  }
  return "AI 服务繁忙，请稍后再试。";
}

async function settleSafely(
  settle: () => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await settle();
  } catch (error) {
    onError?.(error);
  }
}

export async function handleDsAsk(
  event: GroupAtMessageEvent,
  question: string,
  deps: DSCommandDependencies,
): Promise<string> {
  const hasAttachments = event.attachments.length > 0;
  if (question.length === 0) {
    if (!hasAttachments) {
      return UNKNOWN_COMMAND_REPLY;
    }
    question = "请阅读并分析这个附件。";
  }
  if (question.length > MAX_QUERY_CHARS) {
    return `问题过长，请控制在 ${MAX_QUERY_CHARS} 字以内。`;
  }

  let config: GroupConfig;
  try {
    config = await deps.configRepository.get(event.groupOpenid);
  } catch {
    return "服务繁忙，请稍后再试。";
  }

  const reservedCost = Math.min(
    estimateMaxRequestCost(config.model, hasAttachments),
    MAX_RESERVATION_NANO_USD,
  );
  let globalReservation: ReservationResult;
  try {
    globalReservation = await deps.globalBudget.reserve(reservedCost);
  } catch {
    return "服务繁忙，请稍后再试。";
  }
  if (!globalReservation.allowed) {
    return "当前 AI 服务额度已用完，请稍后再试。";
  }

  let groupReservation: ReservationResult;
  try {
    groupReservation = await deps.eventGuard.reserveAsk(event.memberOpenid, reservedCost);
  } catch (error) {
    await settleSafely(
      () => deps.globalBudget.settle(globalReservation.dayKey, reservedCost, 0),
      deps.onSettlementError,
    );
    throw error;
  }
  if (!groupReservation.allowed) {
    await settleSafely(
      () => deps.globalBudget.settle(globalReservation.dayKey, reservedCost, 0),
      deps.onSettlementError,
    );
    return deniedReply(
      groupReservation,
      deps.groupLimitPerMinute,
      deps.memberCooldownSeconds,
    );
  }

  let attachments: LoadedAttachment[];
  try {
    attachments = await deps.attachmentLoader.load(event.attachments);
  } catch (error) {
    await Promise.all([
      settleSafely(
        () =>
          deps.eventGuard.settleAsk(
            groupReservation.dayKey,
            reservedCost,
            0,
          ),
        deps.onSettlementError,
      ),
      settleSafely(
        () =>
          deps.globalBudget.settle(
            globalReservation.dayKey,
            reservedCost,
            0,
          ),
        deps.onSettlementError,
      ),
    ]);
    if (error instanceof AppError && error.code === "attachment_too_large") {
      return "附件总大小或单文件大小超过限制，请压缩后重试。";
    }
    return "附件读取失败，请重新上传后再试。";
  }

  try {
    const completion = await deps.aiClient.complete({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      systemPrompt: config.systemPrompt,
      question,
      attachments,
      ...(attachments.length > 0
        ? { timeoutMs: AI_TIMEOUT_MS - ATTACHMENT_TIMEOUT_MS }
        : {}),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const actualCost = Math.min(
      reservedCost,
      actualRequestCost(config.model, completion.usage),
    );
    await Promise.all([
      settleSafely(
        () =>
          deps.eventGuard.settleAsk(
            groupReservation.dayKey,
            reservedCost,
            actualCost,
          ),
        deps.onSettlementError,
      ),
      settleSafely(
        () =>
          deps.globalBudget.settle(
            globalReservation.dayKey,
            reservedCost,
            actualCost,
          ),
        deps.onSettlementError,
      ),
    ]);
    return truncateText(completion.content, MAX_REPLY_CHARS);
  } catch (error) {
    const actualCost =
      error instanceof DeepSeekError && error.requestMayBeBillable ? reservedCost : 0;
    await Promise.all([
      settleSafely(
        () =>
          deps.eventGuard.settleAsk(
            groupReservation.dayKey,
            reservedCost,
            actualCost,
          ),
        deps.onSettlementError,
      ),
      settleSafely(
        () =>
          deps.globalBudget.settle(
            globalReservation.dayKey,
            reservedCost,
            actualCost,
          ),
        deps.onSettlementError,
      ),
    ]);
    return upstreamFailureReply(error);
  }
}

function invalidSetReply(field: DSConfigField): string {
  if (field === "model") {
    return `模型无效。可选值：${ALLOWED_MODELS.join("、")}。`;
  }
  if (field === "think") {
    return `思考强度无效。可选值：${ALLOWED_REASONING_EFFORTS.join("、")}。`;
  }
  return `System Prompt 不能为空，且不能超过 ${MAX_SYSTEM_PROMPT_CHARS} 字。`;
}

export async function handleDsSet(
  event: GroupAtMessageEvent,
  field: DSConfigField,
  rawValue: string,
  deps: DSCommandDependencies,
): Promise<string> {
  if (!canManageGroup(event, deps.adminWhitelist)) {
    return PERMISSION_DENIED_REPLY;
  }

  const changes: GroupConfigChanges = {};
  let successReply: string;

  if (field === "model") {
    const value = rawValue.trim().toLowerCase();
    if (!ALLOWED_MODELS.includes(value as DeepSeekModel) || /\s/.test(value)) {
      return invalidSetReply(field);
    }
    changes.model = value as DeepSeekModel;
    successReply = `已更新本群模型为 ${changes.model}。`;
  } else if (field === "think") {
    const value = rawValue.trim().toLowerCase();
    if (!ALLOWED_REASONING_EFFORTS.includes(value as ReasoningEffort) || /\s/.test(value)) {
      return invalidSetReply(field);
    }
    changes.reasoningEffort = value as ReasoningEffort;
    successReply = `已更新本群思考强度为 ${changes.reasoningEffort}。`;
  } else {
    const value = rawValue.trim();
    if (value.length === 0 || value.length > MAX_SYSTEM_PROMPT_CHARS) {
      return invalidSetReply(field);
    }
    changes.systemPrompt = value;
    successReply = `已更新本群 System Prompt（${value.length} 字）。`;
  }

  try {
    await deps.configRepository.update(event.groupOpenid, event.memberOpenid, changes);
    return successReply;
  } catch {
    return "配置更新失败，请稍后再试。";
  }
}

export async function handleDsClear(
  event: GroupAtMessageEvent,
  field: DSConfigField,
  deps: DSCommandDependencies,
): Promise<string> {
  if (!canManageGroup(event, deps.adminWhitelist)) {
    return PERMISSION_DENIED_REPLY;
  }

  const changes: GroupConfigChanges = {};
  if (field === "model") {
    changes.model = DEFAULT_MODEL;
  } else if (field === "think") {
    changes.reasoningEffort = DEFAULT_REASONING_EFFORT;
  } else {
    changes.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  try {
    await deps.configRepository.update(event.groupOpenid, event.memberOpenid, changes);
  } catch {
    return "配置重置失败，请稍后再试。";
  }

  if (field === "model") {
    return `已将本群模型恢复为默认值 ${DEFAULT_MODEL}。`;
  }
  if (field === "think") {
    return `已将本群思考强度恢复为默认值 ${DEFAULT_REASONING_EFFORT}。`;
  }
  return "已将本群 System Prompt 恢复为默认值。";
}

export async function handleDsQuery(
  event: GroupAtMessageEvent,
  field: DSConfigField,
  deps: DSCommandDependencies,
): Promise<string> {
  if (!canManageGroup(event, deps.adminWhitelist)) {
    return PERMISSION_DENIED_REPLY;
  }

  let config: GroupConfig;
  try {
    config = await deps.configRepository.get(event.groupOpenid);
  } catch {
    return "读取本群配置失败，请稍后再试。";
  }

  if (field === "model") {
    return `本群当前模型：${config.model}`;
  }
  if (field === "think") {
    return `本群当前思考强度：${config.reasoningEffort}`;
  }
  return `本群当前 System Prompt（${config.systemPrompt.length} 字）：\n${config.systemPrompt}`;
}

export function handleDsList(field: "model" | "think" | "all"): string {
  const modelLine = `可用模型：${ALLOWED_MODELS.join("、")}`;
  const thinkLine = `可用思考等级：${ALLOWED_REASONING_EFFORTS.join("、")}`;
  if (field === "model") {
    return modelLine;
  }
  if (field === "think") {
    return thinkLine;
  }
  return `${modelLine}\n${thinkLine}`;
}
