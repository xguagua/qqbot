import type { AIClient } from "../ai/deepseek";
import { actualRequestCost, estimateMaxRequestCost } from "../ai/pricing";
import {
  CODE_OUTPUT_REFUSAL,
  CODE_REQUEST_REFUSAL,
  FIREFLY_SYSTEM_PROMPT,
  PROMPT_INJECTION_REFUSAL,
  containsCodeLikeOutput,
  isCodeRequest,
  isPromptInjectionAttempt,
} from "../chat/policy";
import {
  MAX_CHAT_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  MAX_REPLY_CHARS,
  MAX_RESERVATION_NANO_USD,
  AI_TIMEOUT_MS,
  ATTACHMENT_TIMEOUT_MS,
  type DeepSeekModel,
  type ReasoningEffort,
} from "../config";
import type { ChatMessage } from "../chat/types";
import { AppError, DeepSeekError } from "../errors";
import type { AttachmentLoader, LoadedAttachment } from "../files/attachments";
import type { GroupAtMessageEvent } from "../qq/schema";
import type { EventGuard, GlobalBudget, ReservationResult } from "../security/ratelimit";
import type { ChatSessionRepository } from "../storage/chat";
import { truncateText } from "../util";

const CHAT_MODEL: DeepSeekModel = "deepseek-flash";
const CHAT_REASONING_EFFORT: ReasoningEffort = "none";

export interface ChatCommandDependencies {
  chatRepository: ChatSessionRepository;
  eventGuard: EventGuard;
  globalBudget: GlobalBudget;
  aiClient: AIClient;
  attachmentLoader: AttachmentLoader;
  onPolicyBlock?: (reason: "code_request" | "prompt_injection" | "code_output") => void;
  onSettlementError?: (error: unknown) => void;
}

function deniedReply(
  result: ReservationResult,
): string {
  void result;
  return "本群今日 AI 额度已用完，请稍后再试。";
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
      return "AI 未返回有效回答，请稍后再试。";
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

export async function handleChat(
  event: GroupAtMessageEvent,
  message: string,
  deps: ChatCommandDependencies,
): Promise<string> {
  const hasAttachments = event.attachments.length > 0;
  let question = message.trim();
  if (question.length === 0) {
    if (!hasAttachments) {
      return "想和流萤聊些什么呢？";
    }
    question = "请看看这个附件，和我聊聊你注意到了什么。";
  }
  if (question.length > MAX_CHAT_INPUT_CHARS) {
    return `消息过长，请控制在 ${MAX_CHAT_INPUT_CHARS} 字以内。`;
  }
  if (isPromptInjectionAttempt(question)) {
    deps.onPolicyBlock?.("prompt_injection");
    return PROMPT_INJECTION_REFUSAL;
  }
  if (isCodeRequest(question)) {
    deps.onPolicyBlock?.("code_request");
    return CODE_REQUEST_REFUSAL;
  }

  const reservedCost = Math.min(
    estimateMaxRequestCost(CHAT_MODEL, hasAttachments),
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
    groupReservation = await deps.eventGuard.reserveChat(
      event.memberOpenid,
      reservedCost,
    );
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
    return deniedReply(groupReservation);
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

  let history: ChatMessage[];
  try {
    history = await deps.chatRepository.load(
      event.groupOpenid,
      event.memberOpenid,
    );
  } catch {
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
    return "聊天服务繁忙，请稍后再试。";
  }

  let reply: string;
  let actualCost: number;
  try {
    const completion = await deps.aiClient.complete({
      model: CHAT_MODEL,
      reasoningEffort: CHAT_REASONING_EFFORT,
      systemPrompt: FIREFLY_SYSTEM_PROMPT,
      question,
      history,
      attachments,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(attachments.length > 0
        ? { timeoutMs: AI_TIMEOUT_MS - ATTACHMENT_TIMEOUT_MS }
        : {}),
    });
    actualCost = Math.min(
      reservedCost,
      actualRequestCost(CHAT_MODEL, completion.usage),
    );
    reply = truncateText(completion.content, MAX_REPLY_CHARS);
  } catch (error) {
    const failureCost =
      error instanceof DeepSeekError && error.requestMayBeBillable
        ? reservedCost
        : 0;
    await Promise.all([
      settleSafely(
        () =>
          deps.eventGuard.settleAsk(
            groupReservation.dayKey,
            reservedCost,
            failureCost,
          ),
        deps.onSettlementError,
      ),
      settleSafely(
        () =>
          deps.globalBudget.settle(
            globalReservation.dayKey,
            reservedCost,
            failureCost,
          ),
        deps.onSettlementError,
      ),
    ]);
    return upstreamFailureReply(error);
  }

  if (containsCodeLikeOutput(reply)) {
    reply = CODE_OUTPUT_REFUSAL;
    deps.onPolicyBlock?.("code_output");
  } else {
    try {
      await deps.chatRepository.appendTurn(
        event.groupOpenid,
        event.memberOpenid,
        question,
        reply,
      );
    } catch {
      reply = "聊天记录暂时无法保存，请稍后再试。";
    }
  }

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
  return reply;
}
