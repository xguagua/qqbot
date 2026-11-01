export type DSConfigField = "model" | "think" | "spm";

export type ParsedCommand =
  | { kind: "ping" }
  | { kind: "ds_ask"; question: string }
  | { kind: "ds_set"; field: DSConfigField; value: string }
  | { kind: "ds_clear"; field: DSConfigField }
  | { kind: "ds_query"; field: DSConfigField }
  | { kind: "invalid"; usage: "ask" | "set" | "ds" };

export const DS_USAGE =
  "用法：/DS ask <问题>、/DS set <model|think|spm> <值>、" +
  "/DS clear <model|think|spm>、/DS query <model|think|spm>";

export function parseCommand(rawContent: string): ParsedCommand | null {
  const content = rawContent.trim();
  if (content.length === 0) {
    return null;
  }
  if (/^ping$/i.test(content)) {
    return { kind: "ping" };
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

  if (/^\/ds(?:\s|$)/i.test(content)) {
    return { kind: "invalid", usage: "ds" };
  }
  return null;
}
