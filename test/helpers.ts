import type { AIClient, DeepSeekCompletion, DeepSeekCompletionRequest } from "../src/ai/deepseek";
import type { ChatMessage } from "../src/chat/types";
import type {
  AttachmentLoader,
  LoadedAttachment,
} from "../src/files/attachments";
import { DEFAULT_SYSTEM_PROMPT, type Env, type RuntimeConfig } from "../src/config";
import type { Logger, LogFields } from "../src/log";
import type {
  GroupAtMessageEvent,
  MemberRole,
  QQAttachment,
} from "../src/qq/schema";
import { signWebhookPayload } from "../src/qq/verify";
import type { MessageSender, QQMessage } from "../src/qq/client";
import {
  GlobalBudgetStateMachine,
  GroupGuardState,
  type EventGuard,
  type GlobalBudget,
  type ReservationResult,
} from "../src/security/ratelimit";
import type {
  ConfigRepository,
  GroupConfig,
  GroupConfigChanges,
} from "../src/storage/config";
import { defaultGroupConfig } from "../src/storage/config";
import type { ChatSessionRepository } from "../src/storage/chat";
import type { Bytes } from "../src/util";
import type {
  DependencyFactory,
  WebhookDependencies,
} from "../src/worker";

// Public sample AppSecret from QQ's webhook challenge documentation.
export const TEST_SECRET = "DG5g3B4j9X2KOErG";
export const TEST_APP_ID = "test-app-id";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    GROUP_GUARD: {} as DurableObjectNamespace,
    GLOBAL_BUDGET: {} as DurableObjectNamespace,
    QQ_APP_ID: TEST_APP_ID,
    QQ_CLIENT_SECRET: TEST_SECRET,
    DEEPSEEK_API_KEY: "test-deepseek-key",
    ADMIN_WHITELIST: "{}",
    DS_GROUP_LIMIT_PER_MINUTE: "3",
    DS_MEMBER_COOLDOWN_SECONDS: "30",
    DS_GROUP_DAILY_BUDGET_NANO_USD: "100000000",
    DS_GLOBAL_DAILY_BUDGET_NANO_USD: "5000000000",
    ...overrides,
  };
}

export function event(overrides: Partial<GroupAtMessageEvent> = {}): GroupAtMessageEvent {
  const now = new Date();
  return {
    kind: "event",
    messageId: "message-1",
    groupOpenid: "group-a",
    memberOpenid: "member-1",
    memberRole: "member",
    content: "ping",
    messageType: 0,
    quotedContent: undefined,
    attachments: [],
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
  } = {},
): Promise<Request> {
  const payload = {
    op: 0,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: value.messageId,
      group_openid: value.groupOpenid,
      author: {
        member_openid: value.memberOpenid,
        member_role: value.memberRole,
      },
      content: value.content,
      attachments: value.attachments.map((attachment) => ({
        url: attachment.url,
        filename: attachment.filename,
        content_type: attachment.contentType,
        size: attachment.size,
      })),
      timestamp: value.timestamp,
      message_type: value.messageType,
      msg_elements:
        value.quotedContent === undefined
          ? []
          : [{ content: value.quotedContent, message_type: 103 }],
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

export class MemoryConfigRepository implements ConfigRepository {
  readonly configs = new Map<string, GroupConfig>();
  readonly updates: Array<{
    groupOpenid: string;
    actor: string;
    fields: GroupConfigChanges;
  }> = [];

  async get(groupOpenid: string): Promise<GroupConfig> {
    return { ...(this.configs.get(groupOpenid) ?? defaultGroupConfig(groupOpenid)) };
  }

  async update(
    groupOpenid: string,
    actor: string,
    changes: GroupConfigChanges,
  ): Promise<GroupConfig> {
    const previous = await this.get(groupOpenid);
    const next: GroupConfig = {
      ...previous,
      ...changes,
      updatedByOpenid: actor,
      updatedAt: new Date().toISOString(),
      version: previous.version + 1,
    };
    this.configs.set(groupOpenid, next);
    this.updates.push({ groupOpenid, actor, fields: changes });
    return { ...next };
  }

  async cleanupAudits(): Promise<void> {}

  seed(groupOpenid: string, changes: Partial<GroupConfig>): void {
    this.configs.set(groupOpenid, {
      ...defaultGroupConfig(groupOpenid),
      ...changes,
    });
  }
}

export class FakeEventGuard implements EventGuard {
  readonly machine: GroupGuardState;
  readonly #now: () => number;

  constructor(machine: GroupGuardState, now: () => number = Date.now) {
    this.machine = machine;
    this.#now = now;
  }

  async claimEvent(messageId: string): Promise<boolean> {
    return this.machine.claimEvent(messageId, this.#now());
  }

  async reserveAsk(memberOpenid: string, reservedNanoUsd: number): Promise<ReservationResult> {
    return this.machine.reserveAsk(memberOpenid, reservedNanoUsd, this.#now());
  }

  async reserveChat(memberOpenid: string, reservedNanoUsd: number): Promise<ReservationResult> {
    return this.machine.reserveChat(memberOpenid, reservedNanoUsd, this.#now());
  }

  async settleAsk(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void> {
    this.machine.settleAsk(dayKey, reservedNanoUsd, actualNanoUsd);
  }
}

export class FakeGlobalBudget implements GlobalBudget {
  readonly machine: GlobalBudgetStateMachine;

  constructor(machine: GlobalBudgetStateMachine) {
    this.machine = machine;
  }

  async reserve(reservedNanoUsd: number): Promise<ReservationResult> {
    return this.machine.reserve(reservedNanoUsd, Date.now());
  }

  async settle(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void> {
    this.machine.settle(dayKey, reservedNanoUsd, actualNanoUsd);
  }
}

export class FakeAIClient implements AIClient {
  readonly requests: DeepSeekCompletionRequest[] = [];
  response: DeepSeekCompletion = {
    content: "测试回答",
    usage: { promptTokens: 100, completionTokens: 20 },
  };
  error: unknown;

  async complete(request: DeepSeekCompletionRequest): Promise<DeepSeekCompletion> {
    this.requests.push(request);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.response;
  }
}

export class FakeMessageSender implements MessageSender {
  readonly messages: QQMessage[] = [];

  async sendText(message: QQMessage): Promise<void> {
    this.messages.push(message);
  }
}

export class FakeAttachmentLoader implements AttachmentLoader {
  readonly requests: Array<readonly QQAttachment[]> = [];
  loaded: LoadedAttachment[] = [
    {
      kind: "file",
      filename: "example.txt",
      dataUrl: "data:text/plain;base64,aGVsbG8=",
    },
  ];
  error: unknown;

  async load(attachments: readonly QQAttachment[]): Promise<LoadedAttachment[]> {
    this.requests.push(attachments);
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.loaded;
  }
}

export class MemoryChatRepository implements ChatSessionRepository {
  readonly sessions = new Map<string, ChatMessage[]>();

  async load(groupOpenid: string, memberOpenid: string): Promise<ChatMessage[]> {
    return [...(this.sessions.get(`${groupOpenid}\u0000${memberOpenid}`) ?? [])];
  }

  async appendTurn(
    groupOpenid: string,
    memberOpenid: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    const key = `${groupOpenid}\u0000${memberOpenid}`;
    const messages: ChatMessage[] = [
      ...(this.sessions.get(key) ?? []),
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantMessage },
    ];
    this.sessions.set(key, messages.slice(-8));
  }

  async cleanupExpired(): Promise<void> {}
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
  configs: MemoryConfigRepository;
  chats: MemoryChatRepository;
  attachments: FakeAttachmentLoader;
  guards: Map<string, FakeEventGuard>;
  globalBudget: FakeGlobalBudget;
  ai: FakeAIClient;
  sender: FakeMessageSender;
  logger: FakeLogger;
  factory: DependencyFactory;
  tasks: Promise<unknown>[];
  ctx: { waitUntil(task: Promise<unknown>): void };
  flush(): Promise<void>;
  runtime(): RuntimeConfig;
}

export function createHarness(options: {
  groupLimit?: number;
  cooldownMs?: number;
  groupBudget?: number;
  globalBudget?: number;
  runtime?: Partial<RuntimeConfig>;
  now?: () => number;
} = {}): Harness {
  const configs = new MemoryConfigRepository();
  const chats = new MemoryChatRepository();
  const attachments = new FakeAttachmentLoader();
  const guards = new Map<string, FakeEventGuard>();
  const groupLimitPerMinute = options.groupLimit ?? 3;
  const memberCooldownMs = options.cooldownMs ?? 30_000;
  const groupDailyBudgetNanoUsd = options.groupBudget ?? 100_000_000;
  const global = new FakeGlobalBudget(
    new GlobalBudgetStateMachine(
      { dayKey: new Date().toISOString().slice(0, 10), spentNanoUsd: 0 },
      options.globalBudget ?? 5_000_000_000,
    ),
  );
  const ai = new FakeAIClient();
  const sender = new FakeMessageSender();
  const logger = new FakeLogger();
  const tasks: Promise<unknown>[] = [];

  let computedRuntime: RuntimeConfig | undefined;
  const factory: DependencyFactory = (_env, runtime) => {
    computedRuntime = { ...runtime, ...options.runtime };
    const deps: WebhookDependencies = {
      configRepository: configs,
      chatRepository: chats,
      attachmentLoader: attachments,
      eventGuard(groupOpenid) {
        let guard = guards.get(groupOpenid);
        if (guard === undefined) {
          guard = new FakeEventGuard(
            new GroupGuardState(
              {
                events: {},
                windowStartedAt: 0,
                windowCount: 0,
                memberCooldowns: {},
                budgetDay: new Date().toISOString().slice(0, 10),
                budgetSpentNanoUsd: 0,
              },
              {
                groupLimitPerMinute,
                memberCooldownMs,
                groupDailyBudgetNanoUsd,
              },
            ),
            options.now ?? Date.now,
          );
          guards.set(groupOpenid, guard);
        }
        return guard;
      },
      globalBudget: global,
      messageSender: sender,
      aiClient: ai,
      logger,
      now: Date.now,
    };
    return deps;
  };

  return {
    configs,
    chats,
    attachments,
    guards,
    globalBudget: global,
    ai,
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

export function bytes(value: string): Bytes {
  return new TextEncoder().encode(value);
}

export function role(value: MemberRole): MemberRole {
  return value;
}

export const testDefaultPrompt = DEFAULT_SYSTEM_PROMPT;
