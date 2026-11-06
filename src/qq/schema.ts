import { MAX_QUOTED_CONTEXT_CHARS } from "../config";
import { AppError } from "../errors";
import { asRecord, isNonEmptyString, isString } from "../util";

export type MemberRole = "member" | "admin" | "owner";

export interface ChallengePayload {
  kind: "challenge";
  plainToken: string;
  eventTs: string;
}

export interface QQAttachment {
  url: string;
  filename: string | undefined;
  contentType: string | undefined;
  size: number | undefined;
}

export interface GroupAtMessageEvent {
  kind: "event";
  messageId: string;
  groupOpenid: string;
  memberOpenid: string;
  memberRole: MemberRole;
  content: string;
  messageType: 0 | 103;
  quotedContent: string | undefined;
  attachments: readonly QQAttachment[];
  timestamp: string;
  timestampMs: number;
}

export type WebhookPayload = ChallengePayload | GroupAtMessageEvent | null;

function parseChallenge(d: Record<string, unknown>): ChallengePayload {
  if (!isNonEmptyString(d.plain_token) || !isNonEmptyString(d.event_ts)) {
    throw new AppError("invalid_request", "Invalid challenge payload", 400);
  }
  return { kind: "challenge", plainToken: d.plain_token, eventTs: d.event_ts };
}

function parseAttachments(value: unknown): QQAttachment[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AppError("invalid_request", "Invalid attachments", 400);
  }
  return value.map((item) => {
    const attachment = asRecord(item);
    if (attachment === null || !isNonEmptyString(attachment.url)) {
      throw new AppError("invalid_request", "Invalid attachment", 400);
    }
    return {
      url: attachment.url,
      filename: isNonEmptyString(attachment.filename) ? attachment.filename : undefined,
      contentType: isNonEmptyString(attachment.content_type)
        ? attachment.content_type
        : undefined,
      size:
        typeof attachment.size === "number" &&
        Number.isSafeInteger(attachment.size) &&
        attachment.size > 0
          ? attachment.size
          : undefined,
    };
  });
}

function parseQuotedContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const element = asRecord(item);
    if (element !== null && isNonEmptyString(element.content)) {
      return element.content.trim().slice(0, MAX_QUOTED_CONTEXT_CHARS);
    }
  }
  return undefined;
}

function parseGroupEvent(t: unknown, d: unknown): GroupAtMessageEvent | null {
  if (t !== "GROUP_AT_MESSAGE_CREATE") {
    return null;
  }

  const data = asRecord(d);
  const author = asRecord(data?.author);
  if (data === null || author === null) {
    throw new AppError("invalid_request", "Invalid group message event", 400);
  }

  if (
    !isNonEmptyString(data.id) ||
    data.id.length > 512 ||
    !isNonEmptyString(data.group_openid) ||
    data.group_openid.length > 512 ||
    !isNonEmptyString(author.member_openid) ||
    author.member_openid.length > 512 ||
    !isString(data.content) ||
    !isNonEmptyString(data.timestamp)
  ) {
    throw new AppError("invalid_request", "Required group message fields are missing", 400);
  }

  const role = author.member_role;
  if (role !== "member" && role !== "admin" && role !== "owner") {
    throw new AppError("invalid_request", "Invalid member role", 400);
  }

  if (
    (data.message_type !== 0 && data.message_type !== 103) ||
    (data.ark_data !== undefined && data.ark_data !== null)
  ) {
    return null;
  }

  const timestampMs = Date.parse(data.timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new AppError("invalid_request", "Invalid event timestamp", 400);
  }

  return {
    kind: "event",
    messageId: data.id,
    groupOpenid: data.group_openid,
    memberOpenid: author.member_openid,
    memberRole: role,
    content: data.content,
    messageType: data.message_type,
    quotedContent: parseQuotedContent(data.msg_elements),
    attachments: parseAttachments(data.attachments),
    timestamp: data.timestamp,
    timestampMs,
  };
}

export function parseWebhookPayload(payload: Record<string, unknown>): WebhookPayload {
  if (payload.op === 13) {
    const data = asRecord(payload.d);
    if (data === null) {
      throw new AppError("invalid_request", "Invalid challenge payload", 400);
    }
    return parseChallenge(data);
  }

  if (payload.op !== 0) {
    throw new AppError("invalid_request", "Unsupported webhook operation", 400);
  }
  return parseGroupEvent(payload.t, payload.d);
}
