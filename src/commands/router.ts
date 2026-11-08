import { MAX_AT_MESSAGE_CHARS } from "../config";

export type ParsedCommand =
  | { kind: "at_request"; message: string; mentionIds: readonly string[] }
  | { kind: "version" }
  | { kind: "invalid" };

export const UNKNOWN_COMMAND_REPLY = "未知命令，可用命令：/at、/version";

function extractMentionIds(rawContent: string): string[] {
  const angleMentions = [...rawContent.matchAll(/<@!?([^>]+)>/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((id) => id.length > 0);
  if (angleMentions.length > 0) {
    return [...new Set(angleMentions)];
  }

  return [
    ...new Set(
      [...rawContent.matchAll(/<qqbot-at-user\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi)]
        .map((match) => match[1]?.trim() ?? "")
        .filter((id) => id.length > 0),
    ),
  ];
}

export function parseCommand(rawContent: string): ParsedCommand | null {
  const mentionIds = extractMentionIds(rawContent);
  const content = rawContent
    .replace(/<@!?[^>]+>/g, "")
    .trim();
  if (content.length === 0) {
    return null;
  }

  if (/^\/version$/i.test(content)) {
    return { kind: "version" };
  }

  const atRequest = /^\/at(?:\s+([\s\S]*))?$/i.exec(content);
  if (atRequest !== null) {
    const message = (atRequest[1] ?? "")
      .replace(/<qqbot-[^>]*>/gi, "")
      .replace(/<@!?[^>]+>/g, "")
      .trim();
    if (message.length > MAX_AT_MESSAGE_CHARS) {
      return { kind: "invalid" };
    }
    return { kind: "at_request", message, mentionIds };
  }

  if (content.startsWith("/")) {
    return { kind: "invalid" };
  }
  return null;
}
