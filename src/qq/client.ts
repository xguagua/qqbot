import { QQ_TIMEOUT_MS, REPLY_WINDOW_MS, REPLY_WINDOW_SAFETY_MS } from "../config";
import { AppError } from "../errors";
import { asRecord, isNonEmptyString } from "../util";
import type { TokenProvider } from "./auth";

export interface QQMessage {
  groupOpenid: string;
  messageId: string;
  eventTimestampMs: number;
  content: string;
  sequence: number;
  format?: QQMessageFormat;
}

export type QQMessageFormat = "text" | "markdown" | "mention";

export interface MessageSender {
  sendMessage(message: QQMessage): Promise<void>;
}

export interface QQApiClientOptions {
  tokens: TokenProvider;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
}

export class QQApiClient implements MessageSender {
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(options: QQApiClientOptions) {
    this.#tokens = options.tokens;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? QQ_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? "https://api.bot.qq.com";
  }

  async sendMessage(message: QQMessage): Promise<void> {
    if (
      this.#now() - message.eventTimestampMs >
      REPLY_WINDOW_MS - REPLY_WINDOW_SAFETY_MS
    ) {
      throw new AppError("reply_window_expired", "QQ passive reply window expired");
    }
    if (
      message.content.trim().length === 0 ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence < 1
    ) {
      throw new AppError("invalid_request", "Invalid QQ message");
    }

    const token = await this.#tokens.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const format = message.format ?? "text";
    const body =
      format === "markdown" || format === "mention"
        ? {
            msg_type: 2,
            markdown: {
              content: message.content,
            },
            msg_id: message.messageId,
            msg_seq: message.sequence,
          }
        : {
            msg_type: 0,
            content: message.content,
            msg_id: message.messageId,
            msg_seq: message.sequence,
          };
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/v2/groups/${encodeURIComponent(message.groupOpenid)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `QQBot ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
    } catch {
      throw new AppError(
        "upstream_unavailable",
        "QQ message request failed",
        500,
        "qq_message_network",
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(
        "upstream_unavailable",
        "QQ message response was not JSON",
        500,
        "qq_message_invalid_json",
      );
    }
    const record = asRecord(payload);

    if (response.status === 401 || response.status === 403) {
      this.#tokens.invalidate();
    }
    if (!response.ok) {
      throw new AppError(
        "qq_business_error",
        "QQ message endpoint failed",
        502,
        `qq_message_http_${response.status}`,
      );
    }
    if (record?.code !== undefined && record.code !== 0) {
      const safeCode = String(record.code).replace(/[^0-9]/g, "").slice(0, 16) || "unknown";
      throw new AppError(
        "qq_business_error",
        "QQ message endpoint returned a business error",
        502,
        `qq_message_business_${safeCode}`,
      );
    }
    if (!isNonEmptyString(record?.id)) {
      throw new AppError(
        "qq_business_error",
        "QQ message response omitted id",
        502,
        "qq_message_missing_id",
      );
    }
  }
}
