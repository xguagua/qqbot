import { handleAtRequest } from "./commands/at";
import { UNKNOWN_COMMAND_REPLY, parseCommand } from "./commands/router";
import type { CommandResult } from "./commands/types";
import { versionReply } from "./commands/version";
import {
  MAX_REPLY_CHARS,
  REPLY_WINDOW_MS,
  REPLY_WINDOW_SAFETY_MS,
  loadRuntimeConfig,
  type Env,
  type RuntimeConfig,
} from "./config";
import { AppError, errorCode, errorDiagnostic } from "./errors";
import { ConsoleLogger, type Logger } from "./log";
import { QQApiClient, type MessageSender } from "./qq/client";
import { QQTokenProvider, type TokenProvider } from "./qq/auth";
import {
  parseWebhookPayload,
  type GroupAtMessageEvent,
} from "./qq/schema";
import { signWebhookChallenge, verifyWebhookSignature } from "./qq/verify";
import { DurableEventGuard, type EventGuard } from "./security/ratelimit";
import { jsonResponse, readJsonObject, truncateText } from "./util";

export interface WebhookDependencies {
  eventGuard(groupOpenid: string): EventGuard;
  messageSender: MessageSender;
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
    eventGuard: (groupOpenid) =>
      new DurableEventGuard(env.GROUP_GUARD, groupOpenid),
    messageSender: token.sender,
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

function commandReply(
  event: GroupAtMessageEvent,
  runtime: RuntimeConfig,
): CommandResult | null {
  if (!event.addressedToBot) {
    return null;
  }

  const command = parseCommand(event.content);
  if (command === null) {
    return null;
  }
  if (command.kind === "invalid") {
    return UNKNOWN_COMMAND_REPLY;
  }
  if (command.kind === "at_request") {
    return handleAtRequest(event, command.message, command.mentionIds);
  }
  return versionReply(runtime);
}

async function sendReply(
  event: GroupAtMessageEvent,
  reply: CommandResult,
  deps: WebhookDependencies,
): Promise<void> {
  const content = typeof reply === "string" ? reply : reply.content;
  await deps.messageSender.sendMessage({
    groupOpenid: event.groupOpenid,
    messageId: event.messageId,
    eventTimestampMs: event.timestampMs,
    content: truncateText(content, MAX_REPLY_CHARS),
    sequence: 1,
    format: typeof reply === "string" ? "text" : reply.format,
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
      eventType: event.eventType,
      durationMs: deps.now() - startedAt,
    });
    return;
  }

  try {
    const reply = commandReply(event, runtime);
    if (reply === null) {
      deps.logger.info({
        outcome: "ignored_command",
        eventType: event.eventType,
        durationMs: deps.now() - startedAt,
      });
      return;
    }
    await sendReply(event, reply, deps);
    deps.logger.info({
      outcome: "reply_sent",
      eventType: event.eventType,
      durationMs: deps.now() - startedAt,
    });
  } catch (error) {
    const detail = errorDiagnostic(error);
    deps.logger.error({
      outcome: "event_failed",
      code: errorCode(error),
      eventType: event.eventType,
      ...(detail === undefined ? {} : { detail }),
      durationMs: deps.now() - startedAt,
    });
    try {
      await sendReply(event, "服务繁忙，请稍后再试。", deps);
    } catch (replyError) {
      deps.logger.error({
        outcome: "error_reply_failed",
        code: errorCode(replyError),
        eventType: event.eventType,
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
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify({ status: "ok" }),
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
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
  if (!(await guard.claimEvent(payload.messageId))) {
    deps.logger.info({
      outcome: "duplicate_event",
      eventType: payload.eventType,
    });
    return jsonResponse({ op: 12 });
  }

  ctx.waitUntil(processEvent(payload, deps, runtime));
  return jsonResponse({ op: 12 });
}

export function handleError(error: unknown): Response {
  if (error instanceof AppError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    return jsonResponse({ error: error.code }, status);
  }
  return jsonResponse({ error: "internal" }, 500);
}
