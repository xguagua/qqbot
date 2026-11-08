import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/router";

describe("minimal command routing", () => {
  it("routes version without case sensitivity", () => {
    expect(parseCommand(" /VERSION ")).toEqual({ kind: "version" });
  });

  it("routes at requests and preserves target mentions", () => {
    expect(parseCommand("/at <@!target-id> 晚上好")).toEqual({
      kind: "at_request",
      message: "晚上好",
      mentionIds: ["target-id"],
    });
    expect(parseCommand('<@!target> /at 你好')).toEqual({
      kind: "at_request",
      message: "你好",
      mentionIds: ["target"],
    });
    expect(parseCommand("/at")).toEqual({
      kind: "at_request",
      message: "",
      mentionIds: [],
    });
  });

  it("rejects unsupported and malformed commands", () => {
    expect(parseCommand("/help")).toEqual({ kind: "invalid" });
    expect(parseCommand("/DS ask hello")).toEqual({ kind: "invalid" });
    expect(parseCommand("/at <@target> " + "x".repeat(501))).toEqual({
      kind: "invalid",
    });
    expect(parseCommand("普通聊天")).toBeNull();
  });
});
