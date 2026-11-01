import type { AIClient } from "./ai/deepseek";
import { DeepSeekClient } from "./ai/deepseek";
import { handleChat, type ChatCommandDependencies } from "./commands/chat";
import {
  handleDsAsk,
  handleDsClear,
  handleDsList,
  handleDsQuery,
  handleDsSet,
  type DSCommandDependencies,
} from "./commands/ds";
import { helpReply } from "./commands/help";
import { PING_REPLY } from "./commands/ping";
import { UNKNOWN_COMMAND_REPLY, parseCommand } from "./commands/router";
import {
  loadRuntimeConfig,
  REPLY_WINDOW_MS,
  REPLY_WINDOW_SAFETY_MS,
  type Env,
  type RuntimeConfig,
} from "./config";
import { AppError, errorCode, errorDiagnostic } from "./errors";
import { HttpAttachmentLoader, type AttachmentLoader } from "./files/attachments";
import { ConsoleLogger, type Logger } from "./log";
import { QQApiClient, type MessageSender } from "./qq/client";
import { QQTokenProvider, type TokenProvider } from "./qq/auth";
import {
  parseWebhookPayload,
  type GroupAtMessageEvent,
} from "./qq/schema";
import { signWebhookChallenge, verifyWebhookSignature } from "./qq/verify";
import {
  DurableEventGuard,
  DurableGlobalBudget,
  type EventGuard,
  type GlobalBudget,
} from "./security/ratelimit";
import {
  D1ConfigRepository,
  type ConfigRepository,
} from "./storage/config";
import { D1ChatRepository, type ChatSessionRepository } from "./storage/chat";
import { jsonResponse, readJsonObject, truncateText } from "./util";
import { MAX_REPLY_CHARS } from "./config";

export interface WebhookDependencies {
  configRepository: ConfigRepository;
  chatRepository: ChatSessionRepository;
  attachmentLoader: AttachmentLoader;
  eventGuard(groupOpenid: string): EventGuard;
  globalBudget: GlobalBudget;
  messageSender: MessageSender;
  aiClient: AIClient;
  logger: Logger;
  now(): number;
}

export type DependencyFactory = (
  env: Env,
  runtime: RuntimeConfig,
) => WebhookDependencies;

let cachedTokenProvider:
  | { identity: string; provider: TokenProvider; sender: MessageSender }
  | undefined;

function defaultTokenProvider(
  runtime: RuntimeConfig,
): { provider: TokenProvider; sender: MessageSender } {
  const identity = `${runtime.qqAppId}\u0000${runtime.qqClientSecret}`;
  if (cachedTokenProvider?.identity === identity) {
    return cachedTokenProvider;
  }
  const provider = new QQTokenProvider({
    appId: runtime.qqAppId,
    clientSecret: runtime.qqClientSecret,
  });
  const sender = new QQApiClient({ tokens: provider });
  cachedTokenProvider = { identity, provider, sender };
  return cachedTokenProvider;
}

export function createDefaultDependencies(
  env: Env,
  runtime: RuntimeConfig,
): WebhookDependencies {
  const token = defaultTokenProvider(runtime);
  return {
    configRepository: new D1ConfigRepository(env.DB),
    chatRepository: new D1ChatRepository(env.DB),
    attachmentLoader: new HttpAttachmentLoader(),
    eventGuard: (groupOpenid) => new DurableEventGuard(env.GROUP_GUARD, groupOpenid),
    globalBudget: new DurableGlobalBudget(env.GLOBAL_BUDGET),
    messageSender: token.sender,
    aiClient: new DeepSeekClient({ apiKey: runtime.deepseekApiKey }),
    logger: new ConsoleLogger(),
    now: Date.now,
  };
}

function dependencyFactoryFor(
  env: Env,
  runtime: RuntimeConfig,
  factory: DependencyFactory | undefined,
): WebhookDependencies {
  return factory === undefined
    ? createDefaultDependencies(env, runtime)
    : factory(env, runtime);
}

function replyForInvalidUsage(usage: "ask" | "set" | "ds"): string {
  void usage;
  return UNKNOWN_COMMAND_REPLY;
}

function dsDependencies(
  deps: WebhookDependencies,
  runtime: RuntimeConfig,
  event: GroupAtMessageEvent,
): DSCommandDependencies {
  return {
    configRepository: deps.configRepository,
    eventGuard: deps.eventGuard(event.groupOpenid),
    globalBudget: deps.globalBudget,
    aiClient: deps.aiClient,
    attachmentLoader: deps.attachmentLoader,
    adminWhitelist: runtime.adminWhitelist,
    groupLimitPerMinute: runtime.groupLimitPerMinute,
    memberCooldownSeconds: runtime.memberCooldownMs / 1_000,
    onSettlementError: (error) => {
      deps.logger.error({ outcome: "settlement_failed", code: errorCode(error) });
    },
  };
}

function chatDependencies(
  deps: WebhookDependencies,
  event: GroupAtMessageEvent,
): ChatCommandDependencies {
  return {
    chatRepository: deps.chatRepository,
    eventGuard: deps.eventGuard(event.groupOpenid),
    globalBudget: deps.globalBudget,
    aiClient: deps.aiClient,
    attachmentLoader: deps.attachmentLoader,
    onPolicyBlock: (reason) => {
      deps.logger.info({ outcome: "chat_request_blocked", detail: reason });
    },
    onSettlementError: (error) => {
      deps.logger.error({ outcome: "settlement_failed", code: errorCode(error) });
    },
  };
}

async function commandReply(
  event: GroupAtMessageEvent,
  deps: WebhookDependencies,
  runtime: RuntimeConfig,
): Promise<string | null> {
  const command = parseCommand(event.content);
  if (command === null) {
    const content = event.content.trim();
    if (
      (content.length > 0 && !content.startsWith("/")) ||
      event.attachments.length > 0
    ) {
      return handleChat(
        event,
        content,
        chatDependencies(deps, event),
      );
    }
    return null;
  }
  if (command.kind === "ping") {
    return PING_REPLY;
  }
  if (command.kind === "invalid") {
    return replyForInvalidUsage(command.usage);
  }
  if (command.kind === "help") {
    return helpReply(command.command);
  }
  if (command.kind === "ds_list") {
    return handleDsList(command.field);
  }

  const shared = dsDependencies(deps, runtime, event);
  if (command.kind === "ds_ask") {
    return handleDsAsk(event, command.question, shared);
  }
  if (command.kind === "ds_clear") {
    return handleDsClear(event, command.field, shared);
  }
  if (command.kind === "ds_query") {
    return handleDsQuery(event, command.field, shared);
  }
  return handleDsSet(event, command.field, command.value, shared);
}

async function sendReply(
  event: GroupAtMessageEvent,
  content: string,
  deps: WebhookDependencies,
): Promise<void> {
  await deps.messageSender.sendText({
    groupOpenid: event.groupOpenid,
    messageId: event.messageId,
    eventTimestampMs: event.timestampMs,
    content: truncateText(content, MAX_REPLY_CHARS),
    sequence: 1,
  });
}

async function processEvent(
  event: GroupAtMessageEvent,
  deps: WebhookDependencies,
  runtime: RuntimeConfig,
): Promise<void> {
  const startedAt = deps.now();
  if (deps.now() - event.timestampMs > REPLY_WINDOW_MS - REPLY_WINDOW_SAFETY_MS) {
    deps.logger.info({
      outcome: "reply_window_expired",
      durationMs: deps.now() - startedAt,
    });
    return;
  }
  try {
    const reply = await commandReply(event, deps, runtime);
    if (reply === null) {
      deps.logger.info({
        outcome: "ignored_command",
        durationMs: deps.now() - startedAt,
      });
      return;
    }
    await sendReply(event, reply, deps);
    deps.logger.info({
      outcome: "reply_sent",
      durationMs: deps.now() - startedAt,
    });
  } catch (error) {
    const detail = errorDiagnostic(error);
    deps.logger.error({
      outcome: "event_failed",
      code: errorCode(error),
      ...(detail === undefined ? {} : { detail }),
      durationMs: deps.now() - startedAt,
    });
    try {
      await sendReply(event, "服务繁忙，请稍后再试。", deps);
    } catch (replyError) {
      const replyDetail = errorDiagnostic(replyError);
      deps.logger.error({
        outcome: "error_reply_failed",
        code: errorCode(replyError),
        ...(replyDetail === undefined ? {} : { detail: replyDetail }),
      });
    }
  }
}

function checkedChallengeAppId(request: Request, runtime: RuntimeConfig): void {
  const appId = request.headers.get("x-bot-appid");
  if (appId !== null && appId !== runtime.qqAppId) {
    throw new AppError("appid_mismatch", "Webhook AppID does not match", 401);
  }
}

export async function handleWebhook(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  dependencyFactory?: DependencyFactory,
): Promise<Response> {
  const url = new URL(request.url);
  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const runtime = loadRuntimeConfig(env);
  const { raw, value } = await readJsonObject(request);
  const payload = parseWebhookPayload(value);

  if (payload?.kind === "challenge") {
    checkedChallengeAppId(request, runtime);
    const signature = await signWebhookChallenge(
      runtime.qqClientSecret,
      payload.eventTs,
      payload.plainToken,
    );
    new ConsoleLogger().info({ outcome: "challenge_signed" });
    return jsonResponse({ plain_token: payload.plainToken, signature });
  }

  await verifyWebhookSignature(request, raw, runtime.qqClientSecret, runtime.qqAppId);
  if (payload?.kind !== "event") {
    return jsonResponse({ op: 12 });
  }

  const deps = dependencyFactoryFor(env, runtime, dependencyFactory);
  const guard = deps.eventGuard(payload.groupOpenid);
  const claimed = await guard.claimEvent(payload.messageId);
  if (!claimed) {
    deps.logger.info({ outcome: "duplicate_event" });
    return jsonResponse({ op: 12 });
  }

  const task = processEvent(payload, deps, runtime);
  ctx.waitUntil(task);
  return jsonResponse({ op: 12 });
}

export async function handleScheduled(
  _controller: ScheduledController,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const repository = new D1ConfigRepository(env.DB);
  const chatRepository = new D1ChatRepository(env.DB);
  const logger = new ConsoleLogger();
  const task = Promise.all([
    repository.cleanupAudits(),
    chatRepository.cleanupExpired(),
  ])
    .then(() => logger.info({ outcome: "audit_cleanup_succeeded" }))
    .catch((error: unknown) =>
      logger.error({ outcome: "audit_cleanup_failed", code: errorCode(error) }),
    );
  ctx.waitUntil(task);
}

export function handleError(error: unknown): Response {
  if (error instanceof AppError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    return jsonResponse({ error: error.code }, status);
  }
  return jsonResponse({ error: "internal" }, 500);
}
