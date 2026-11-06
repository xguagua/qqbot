import { MAX_AT_MESSAGE_CHARS } from "../config";

export type DSConfigField = "model" | "think" | "spm";

export type ParsedCommand =
  | { kind: "ping" }
  | { kind: "ds_ask"; question: string }
  | { kind: "ds_set"; field: DSConfigField; value: string }
  | { kind: "ds_clear"; field: DSConfigField }
  | { kind: "ds_query"; field: DSConfigField }
  | { kind: "ds_list"; field: "model" | "think" | "all" }
  | { kind: "help"; command: string }
  | { kind: "chat_setting"; enabled: boolean | null }
  | { kind: "at_request"; message: string; mentionIds: readonly string[] }
  | { kind: "version" }
  | { kind: "invalid"; usage: "ask" | "set" | "ds" };

export const DS_USAGE =
  "用法：/DS ask <问题>、/DS set <model|think|spm> <值>、" +
  "/DS clear <model|think|spm>、/DS query <model|think|spm>、" +
  "/DS list [model|think]";

export const UNKNOWN_COMMAND_REPLY = "未知命令，请输入 /help 查询";

export function parseCommand(rawContent: string): ParsedCommand | null {
  const mentionIds = [...rawContent.matchAll(/<@!?([^>]+)>/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((id) => id.length > 0);
  const content = rawContent
    .replace(/<@!?[^>]+>/g, "")
    .trim();
  if (content.length === 0) {
    return null;
  }
  if (/^ping$/i.test(content)) {
    return { kind: "ping" };
  }

  const help = /^\/help(?:\s+([\s\S]*))?$/i.exec(content);
  if (help !== null) {
    return { kind: "help", command: (help[1] ?? "").trim() };
  }

  const chatSetting = /^\/chat(?:\s+([\s\S]*))?$/i.exec(content);
  if (chatSetting !== null) {
    const value = (chatSetting[1] ?? "").trim().toLowerCase();
    if (value === "") {
      return { kind: "chat_setting", enabled: null };
    }
    if (value === "true" || value === "false") {
      return { kind: "chat_setting", enabled: value === "true" };
    }
    return { kind: "invalid", usage: "ds" };
  }

  const atRequest = /^\/at(?:\s+([\s\S]*))?$/i.exec(content);
  if (atRequest !== null) {
    const message = (atRequest[1] ?? "")
      .replace(/<qqbot-[^>]*>/gi, "")
      .replace(/<@!?[^>]+>/g, "")
      .trim();
    if (message.length > MAX_AT_MESSAGE_CHARS) {
      return { kind: "invalid", usage: "ds" };
    }
    return { kind: "at_request", message, mentionIds };
  }

  if (/^\/version$/i.test(content)) {
    return { kind: "version" };
  }

  const ask = /^\/ds\s+ask(?:\s+([\s\S]*))?$/i.exec(content);
  if (ask !== null) {
    return { kind: "ds_ask", question: (ask[1] ?? "").trim() };
  }

  const set = /^\/ds\s+set(?:\s+([\s\S]*))?$/i.exec(content);
  if (set !== null) {
    const argument = (set[1] ?? "").trim();
    const fieldMatch = /^(model|think|spm)(?:\s+([\s\S]*))?$/i.exec(argument);
    if (fieldMatch === null) {
      return { kind: "invalid", usage: "set" };
    }
    const field = fieldMatch[1]!.toLowerCase() as DSConfigField;
    return { kind: "ds_set", field, value: (fieldMatch[2] ?? "").trim() };
  }

  const maintenance = /^\/ds\s+(clear|query)(?:\s+([\s\S]*))?$/i.exec(content);
  if (maintenance !== null) {
    const action = maintenance[1]!.toLowerCase() as "clear" | "query";
    const field = (maintenance[2] ?? "").trim().toLowerCase();
    if (field !== "model" && field !== "think" && field !== "spm") {
      return { kind: "invalid", usage: "ds" };
    }
    return action === "clear"
      ? { kind: "ds_clear", field }
      : { kind: "ds_query", field };
  }

  const list = /^\/ds\s+list(?:\s+([\s\S]*))?$/i.exec(content);
  if (list !== null) {
    const field = (list[1] ?? "").trim().toLowerCase();
    if (field === "") {
      return { kind: "ds_list", field: "all" };
    }
    if (field === "model" || field === "think") {
      return { kind: "ds_list", field };
    }
    return { kind: "invalid", usage: "ds" };
  }

  if (content.startsWith("/")) {
    return { kind: "invalid", usage: "ds" };
  }
  return null;
}
