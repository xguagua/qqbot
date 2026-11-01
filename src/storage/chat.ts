import {
  CHAT_CONTEXT_MAX_MESSAGES,
  CHAT_CONTEXT_TTL_MS,
  MAX_CHAT_INPUT_CHARS,
  MAX_REPLY_CHARS,
} from "../config";
import type { ChatMessage } from "../chat/types";
import { AppError } from "../errors";
import { asRecord } from "../util";

export interface ChatSessionRepository {
  load(groupOpenid: string, memberOpenid: string): Promise<ChatMessage[]>;
  appendTurn(
    groupOpenid: string,
    memberOpenid: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void>;
  cleanupExpired(): Promise<void>;
}

interface ChatSessionRow {
  messages_json: string;
  expires_at: string;
}

function parseMessages(raw: string): ChatMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const messages: ChatMessage[] = [];
  for (const value of parsed.slice(-CHAT_CONTEXT_MAX_MESSAGES)) {
    const record = asRecord(value);
    if (
      record === null ||
      (record.role !== "user" && record.role !== "assistant") ||
      typeof record.content !== "string" ||
      record.content.length === 0 ||
      record.content.length > MAX_REPLY_CHARS
    ) {
      return [];
    }
    messages.push({ role: record.role, content: record.content });
  }
  return messages;
}

export class D1ChatRepository implements ChatSessionRepository {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  async load(groupOpenid: string, memberOpenid: string): Promise<ChatMessage[]> {
    try {
      const row = await this.#db
        .prepare(
          "SELECT messages_json, expires_at FROM chat_sessions " +
            "WHERE group_openid = ? AND member_openid = ?",
        )
        .bind(groupOpenid, memberOpenid)
        .first<ChatSessionRow>();
      if (row === null) {
        return [];
      }

      const expiresAt = Date.parse(row.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
        await this.#delete(groupOpenid, memberOpenid);
        return [];
      }
      return parseMessages(row.messages_json);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("storage_unavailable", "Unable to read chat context");
    }
  }

  async appendTurn(
    groupOpenid: string,
    memberOpenid: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    if (
      userMessage.length === 0 ||
      userMessage.length > MAX_CHAT_INPUT_CHARS ||
      assistantMessage.length === 0 ||
      assistantMessage.length > MAX_REPLY_CHARS
    ) {
      throw new AppError("invalid_request", "Invalid chat history message");
    }

    const existing = await this.load(groupOpenid, memberOpenid);
    const messages = [
      ...existing,
      { role: "user" as const, content: userMessage },
      { role: "assistant" as const, content: assistantMessage },
    ].slice(-CHAT_CONTEXT_MAX_MESSAGES);
    const now = this.#now();
    const updatedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + CHAT_CONTEXT_TTL_MS).toISOString();

    try {
      await this.#db
        .prepare(
          "INSERT INTO chat_sessions " +
            "(group_openid, member_openid, messages_json, updated_at, expires_at) " +
            "VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(group_openid, member_openid) DO UPDATE SET " +
            "messages_json = excluded.messages_json, updated_at = excluded.updated_at, " +
            "expires_at = excluded.expires_at",
        )
        .bind(
          groupOpenid,
          memberOpenid,
          JSON.stringify(messages),
          updatedAt,
          expiresAt,
        )
        .run();
    } catch {
      throw new AppError("storage_unavailable", "Unable to save chat context");
    }
  }

  async cleanupExpired(): Promise<void> {
    try {
      await this.#db
        .prepare("DELETE FROM chat_sessions WHERE expires_at <= ?")
        .bind(new Date(this.#now()).toISOString())
        .run();
    } catch {
      throw new AppError("storage_unavailable", "Unable to clean chat contexts");
    }
  }

  async #delete(groupOpenid: string, memberOpenid: string): Promise<void> {
    await this.#db
      .prepare(
        "DELETE FROM chat_sessions WHERE group_openid = ? AND member_openid = ?",
      )
      .bind(groupOpenid, memberOpenid)
      .run();
  }
}
