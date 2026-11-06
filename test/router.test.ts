import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/router";

describe("command routing", () => {
  it("recognizes ping without case sensitivity", () => {
    expect(parseCommand("  PiNg  ")).toEqual({ kind: "ping" });
  });

  it("preserves internal spaces in /DS ask", () => {
    expect(parseCommand(" /ds ASK  如何  学习 TypeScript ")).toEqual({
      kind: "ds_ask",
      question: "如何  学习 TypeScript",
    });
  });

  it("preserves the complete System Prompt", () => {
    expect(parseCommand("/DS set SPM 第一行\n第二行 有 空格")).toEqual({
      kind: "ds_set",
      field: "spm",
      value: "第一行\n第二行 有 空格",
    });
  });

  it("routes model and thinking fields", () => {
    expect(parseCommand("/ds set model DEEPSEEK-FLASH")).toEqual({
      kind: "ds_set",
      field: "model",
      value: "DEEPSEEK-FLASH",
    });
    expect(parseCommand("/ds set think MAX")).toEqual({
      kind: "ds_set",
      field: "think",
      value: "MAX",
    });
  });

  it("routes clear and query commands without case sensitivity", () => {
    expect(parseCommand("/DS CLEAR MODEL")).toEqual({
      kind: "ds_clear",
      field: "model",
    });
    expect(parseCommand("/ds Query THINK")).toEqual({
      kind: "ds_query",
      field: "think",
    });
    expect(parseCommand(" /ds query spm ")).toEqual({
      kind: "ds_query",
      field: "spm",
    });
  });

  it("routes help and DS list commands", () => {
    expect(parseCommand("/HELP")).toEqual({ kind: "help", command: "" });
    expect(parseCommand("/help /DS ask")).toEqual({
      kind: "help",
      command: "/DS ask",
    });
    expect(parseCommand("/DS LIST")).toEqual({
      kind: "ds_list",
      field: "all",
    });
    expect(parseCommand("/ds list MODEL")).toEqual({
      kind: "ds_list",
      field: "model",
    });
    expect(parseCommand("/ds list think")).toEqual({
      kind: "ds_list",
      field: "think",
    });
  });

  it("routes chat enable, disable, and status queries", () => {
    expect(parseCommand("/chat")).toEqual({ kind: "chat_setting", enabled: null });
    expect(parseCommand("/CHAT TRUE")).toEqual({ kind: "chat_setting", enabled: true });
    expect(parseCommand("/chat false")).toEqual({ kind: "chat_setting", enabled: false });
  });

  it("routes version and owner at requests", () => {
    expect(parseCommand("/VERSION")).toEqual({ kind: "version" });
    expect(parseCommand('/at <@!target-id> 你好')).toEqual({
      kind: "at_request",
      message: "你好",
      mentionIds: ["target-id"],
    });
    expect(parseCommand("/at")).toEqual({
      kind: "at_request",
      message: "",
      mentionIds: [],
    });
    expect(parseCommand('<@!target> /at 你好')).toEqual({
      kind: "at_request",
      message: "你好",
      mentionIds: ["target"],
    });
  });

  it("reports malformed DS commands", () => {
    expect(parseCommand("/ds wat")).toEqual({ kind: "invalid", usage: "ds" });
    expect(parseCommand("/ds set unknown value")).toEqual({
      kind: "invalid",
      usage: "set",
    });
    expect(parseCommand("/ds ask")).toEqual({ kind: "ds_ask", question: "" });
    expect(parseCommand("/ds clear")).toEqual({ kind: "invalid", usage: "ds" });
    expect(parseCommand("/ds query model extra")).toEqual({
      kind: "invalid",
      usage: "ds",
    });
    expect(parseCommand("/unknown")).toEqual({ kind: "invalid", usage: "ds" });
    expect(parseCommand("/chat maybe")).toEqual({ kind: "invalid", usage: "ds" });
  });

  it("ignores unrelated messages", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("ping extra")).toBeNull();
  });
});
