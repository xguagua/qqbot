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

export interface MentionedGroupMember {
  id: string;
  memberOpenid: string | undefined;
  role: MemberRole | undefined;
  bot: boolean;
  isYou?: boolean;
}

export interface GroupAtMessageEvent {
  kind: "event";
  eventType: "GROUP_AT_MESSAGE_CREATE" | "GROUP_MESSAGE_CREATE";
  messageId: string;
  groupOpenid: string;
  memberOpenid: string;
  memberRole: MemberRole;
  authorBot: boolean;
  addressedToBot: boolean;
  content: string;
  messageType: 0 | 103;
  quotedContent: string | undefined;
  attachments: readonly QQAttachment[];
  mentions: readonly MentionedGroupMember[];
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

function normalizeMessageText(value: string): string {
  return value
    .replace(/\[<face,id=\d+\/?>]/g, "[表情]")
    .replace(/<faceType=\d+,[^>]+>/g, "[表情]")
    .trim();
}

function parseAttachmentItem(item: unknown): QQAttachment {
  const attachment = asRecord(item);
  if (attachment === null || !isNonEmptyString(attachment.url)) {
    throw new AppError("invalid_request", "Invalid attachments", 400);
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
}

function collectMessageElementAttachments(
  value: unknown,
  depth = 0,
  result: QQAttachment[] = [],
): QQAttachment[] {
  if (!Array.isArray(value) || depth > 3) {
    return result;
  }
  for (const item of value) {
    const element = asRecord(item);
    if (element === null) {
      continue;
    }
    if (Array.isArray(element.attachments)) {
      result.push(...element.attachments.map(parseAttachmentItem));
    }
    collectMessageElementAttachments(element.msg_elements, depth + 1, result);
  }
  return result;
}

function parseAttachments(topLevel: unknown, elements: unknown): QQAttachment[] {
  if (topLevel !== undefined && !Array.isArray(topLevel)) {
    throw new AppError("invalid_request", "Invalid attachments", 400);
  }
  const attachments = [
    ...(Array.isArray(topLevel) ? topLevel.map(parseAttachmentItem) : []),
    ...collectMessageElementAttachments(elements),
  ];
  return attachments.filter(
    (attachment, index) =>
      attachments.findIndex((candidate) => candidate.url === attachment.url) === index,
  );
}

function collectMessageElementTexts(
  value: unknown,
  depth = 0,
  result: string[] = [],
): string[] {
  if (!Array.isArray(value) || depth > 3) {
    return result;
  }
  for (const item of value) {
    const element = asRecord(item);
    if (element === null) {
      continue;
    }
    if (isNonEmptyString(element.content)) {
      const text = normalizeMessageText(element.content);
      if (text.length > 0 && !result.includes(text)) {
        result.push(text);
      }
    }
    collectMessageElementTexts(element.msg_elements, depth + 1, result);
  }
  return result;
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function parseMentions(value: unknown): MentionedGroupMember[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AppError("invalid_request", "Invalid mentions", 400);
  }
  const mentions: MentionedGroupMember[] = [];
  for (const item of value) {
    const mention = asRecord(item);
    if (mention === null) {
      continue;
    }
    const id = isNonEmptyString(mention.id)
      ? mention.id
      : isNonEmptyString(mention.member_openid)
        ? mention.member_openid
        : isNonEmptyString(mention.user_openid)
          ? mention.user_openid
          : undefined;
    if (id === undefined) {
      continue;
    }
    const role =
      mention.member_role === "member" ||
      mention.member_role === "admin" ||
      mention.member_role === "owner"
        ? mention.member_role
        : undefined;
    mentions.push({
      id,
      memberOpenid: isNonEmptyString(mention.member_openid)
        ? mention.member_openid
        : undefined,
      role,
      bot: parseBooleanFlag(mention.bot),
      isYou: parseBooleanFlag(mention.is_you),
    });
  }
  return mentions;
}

function parseQuotedContent(value: unknown): string | undefined {
  const texts = collectMessageElementTexts(value);
  if (texts.length === 0) {
    return undefined;
  }
  const perElementLimit = Math.max(
    40,
    Math.floor(MAX_QUOTED_CONTEXT_CHARS / texts.length),
  );
  return texts
    .map((text) => text.slice(0, perElementLimit))
    .join("\n---\n")
    .slice(0, MAX_QUOTED_CONTEXT_CHARS);
}

function parseGroupEvent(t: unknown, d: unknown): GroupAtMessageEvent | null {
  if (t !== "GROUP_AT_MESSAGE_CREATE" && t !== "GROUP_MESSAGE_CREATE") {
    return null;
  }

  const data = asRecord(d);
  const author = asRecord(data?.author);
  if (data === null || author === null) {
    throw new AppError("invalid_request", "Invalid group message event", 400);
  }
  const groupOpenid = isNonEmptyString(data.group_openid)
    ? data.group_openid
    : isNonEmptyString(data.group_id)
      ? data.group_id
      : undefined;
  const memberOpenid = isNonEmptyString(author.member_openid)
    ? author.member_openid
    : isNonEmptyString(author.id)
      ? author.id
      : undefined;
  const messageType = data.message_type ?? 0;
  const timestamp = isNonEmptyString(data.timestamp)
    ? data.timestamp
    : new Date().toISOString();

  if (
    !isNonEmptyString(data.id) ||
    data.id.length > 512 ||
    groupOpenid === undefined ||
    groupOpenid.length > 512 ||
    memberOpenid === undefined ||
    memberOpenid.length > 512 ||
    !isString(data.content)
  ) {
    throw new AppError("invalid_request", "Required group message fields are missing", 400);
  }

  const role = author.member_role;
  if (role !== "member" && role !== "admin" && role !== "owner") {
    throw new AppError("invalid_request", "Invalid member role", 400);
  }
  const authorBot = parseBooleanFlag(author.bot);
  if (authorBot) {
    return null;
  }

  if ((messageType !== 0 && messageType !== 103) || (data.ark_data !== undefined && data.ark_data !== null)) {
    return null;
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new AppError("invalid_request", "Invalid event timestamp", 400);
  }

  const mentions = parseMentions(data.mentions);
  const addressedToBot =
    t === "GROUP_AT_MESSAGE_CREATE" ||
    mentions.some((mention) => mention.isYou);

  return {
    kind: "event",
    eventType: t,
    messageId: data.id,
    groupOpenid,
    memberOpenid,
    memberRole: role,
    authorBot,
    addressedToBot,
    content: normalizeMessageText(data.content),
    messageType,
    quotedContent: parseQuotedContent(data.msg_elements),
    attachments: parseAttachments(data.attachments, data.msg_elements),
    mentions,
    timestamp,
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
