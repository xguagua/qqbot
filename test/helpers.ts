import type { Env, RuntimeConfig } from "../src/config";
import type { Logger, LogFields } from "../src/log";
import type { MessageSender, QQMessage } from "../src/qq/client";
import type {
  GroupAtMessageEvent,
  MemberRole,
  QQAttachment,
} from "../src/qq/schema";
import { signWebhookPayload } from "../src/qq/verify";
import {
  GroupGuardState,
  type EventGuard,
} from "../src/security/ratelimit";
import type {
  DependencyFactory,
  WebhookDependencies,
} from "../src/worker";

export const TEST_SECRET = "DG5g3B4j9X2KOErG";
export const TEST_APP_ID = "test-app-id";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    GROUP_GUARD: {} as DurableObjectNamespace,
    QQ_APP_ID: TEST_APP_ID,
    QQ_CLIENT_SECRET: TEST_SECRET,
    GIT_COMMIT_SHA: "test-commit",
    DEPLOYED_AT: "2026-11-08T00:00:00+08:00",
    ...overrides,
  };
}

export function event(
  overrides: Partial<GroupAtMessageEvent> = {},
): GroupAtMessageEvent {
  const now = new Date();
  return {
    kind: "event",
    eventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: "message-1",
    groupOpenid: "group-a",
    memberOpenid: "member-1",
    memberRole: "member",
    authorBot: false,
    addressedToBot: true,
    content: "/version",
    messageType: 0,
    quotedContent: undefined,
    attachments: [],
    mentions: [],
    timestamp: now.toISOString(),
    timestampMs: now.getTime(),
    ...overrides,
  };
}

export async function signedEventRequest(
  value: GroupAtMessageEvent,
  options: {
    secret?: string;
    timestamp?: string;
    appId?: string | null;
    elementContents?: readonly string[];
    elementAttachments?: readonly QQAttachment[];
  } = {},
): Promise<Request> {
  const payload = {
    op: 0,
    t: value.eventType,
    d: {
      id: value.messageId,
      group_openid: value.groupOpenid,
      author: {
        member_openid: value.memberOpenid,
        member_role: value.memberRole,
        bot: value.authorBot,
      },
      content: value.content,
      attachments: value.attachments.map((attachment) => ({
        url: attachment.url,
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: attachment.size,
      })),
      mentions: value.mentions.map((mention) => ({
        id: mention.id,
        member_openid: mention.memberOpenid,
        member_role: mention.role,
        bot: mention.bot,
        is_you: mention.isYou,
      })),
      timestamp: value.timestamp,
      message_type: value.messageType,
      msg_elements: [
        ...(value.quotedContent === undefined
          ? []
          : [{ content: value.quotedContent, message_type: 103 }]),
        ...(options.elementContents ?? []).map((content) => ({
          content,
          message_type: 0,
        })),
        ...(options.elementAttachments ?? []).map((attachment) => ({
          content: "",
          message_type: 0,
          attachments: [
            {
              url: attachment.url,
              filename: attachment.filename,
              content_type: attachment.contentType,
              size: attachment.size,
            },
          ],
        })),
      ],
    },
  };
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const signature = await signWebhookPayload(
    options.secret ?? TEST_SECRET,
    timestamp,
    raw,
  );
  const headers = new Headers({
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestamp,
  });
  if (options.appId !== null) {
    headers.set("x-bot-appid", options.appId ?? TEST_APP_ID);
  }
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

export function challengeRequest(appId: string | null = TEST_APP_ID): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (appId !== null) {
    headers.set("x-bot-appid", appId);
  }
  return new Request("https://worker.example/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify({
      op: 13,
      d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" },
    }),
  });
}

export class FakeEventGuard implements EventGuard {
  readonly machine = new GroupGuardState({ events: {} });

  async claimEvent(messageId: string): Promise<boolean> {
    return this.machine.claimEvent(messageId, Date.now());
  }
}

export class FakeMessageSender implements MessageSender {
  readonly messages: QQMessage[] = [];

  async sendMessage(message: QQMessage): Promise<void> {
    this.messages.push(message);
  }
}

export class FakeLogger implements Logger {
  readonly entries: Array<{ level: "info" | "error"; fields: LogFields }> = [];

  info(fields: LogFields): void {
    this.entries.push({ level: "info", fields });
  }

  error(fields: LogFields): void {
    this.entries.push({ level: "error", fields });
  }
}

export interface Harness {
  guards: Map<string, FakeEventGuard>;
  sender: FakeMessageSender;
  logger: FakeLogger;
  factory: DependencyFactory;
  tasks: Promise<unknown>[];
  ctx: { waitUntil(task: Promise<unknown>): void };
  flush(): Promise<void>;
  runtime(): RuntimeConfig;
}

export function createHarness(): Harness {
  const guards = new Map<string, FakeEventGuard>();
  const sender = new FakeMessageSender();
  const logger = new FakeLogger();
  const tasks: Promise<unknown>[] = [];
  let computedRuntime: RuntimeConfig | undefined;

  const factory: DependencyFactory = (_env, runtime) => {
    computedRuntime = runtime;
    const deps: WebhookDependencies = {
      eventGuard(groupOpenid) {
        let guard = guards.get(groupOpenid);
        if (guard === undefined) {
          guard = new FakeEventGuard();
          guards.set(groupOpenid, guard);
        }
        return guard;
      },
      messageSender: sender,
      logger,
      now: Date.now,
    };
    return deps;
  };

  return {
    guards,
    sender,
    logger,
    factory,
    tasks,
    ctx: {
      waitUntil(task) {
        tasks.push(task);
      },
    },
    async flush() {
      await Promise.allSettled(tasks.splice(0));
    },
    runtime() {
      if (computedRuntime === undefined) {
        throw new Error("Runtime has not been initialized");
      }
      return computedRuntime;
    },
  };
}

export function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function role(value: MemberRole): MemberRole {
  return value;
}
