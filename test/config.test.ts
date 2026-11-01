import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config";
import { testEnv } from "./helpers";

describe("runtime configuration", () => {
  it("clamps configurable limits to server-side hard caps", () => {
    const runtime = loadRuntimeConfig(
      testEnv({
        DS_GROUP_LIMIT_PER_MINUTE: "999",
        DS_MEMBER_COOLDOWN_SECONDS: "1",
        DS_GROUP_DAILY_BUDGET_NANO_USD: "999999999999",
        DS_GLOBAL_DAILY_BUDGET_NANO_USD: "999999999999",
      }),
    );
    expect(runtime.groupLimitPerMinute).toBe(10);
    expect(runtime.memberCooldownMs).toBe(10_000);
    expect(runtime.groupDailyBudgetNanoUsd).toBe(1_000_000_000);
    expect(runtime.globalDailyBudgetNanoUsd).toBe(25_000_000_000);
  });

  it("keeps the confirmed initial limits by default", () => {
    const runtime = loadRuntimeConfig(testEnv());
    expect(runtime.groupLimitPerMinute).toBe(3);
    expect(runtime.memberCooldownMs).toBe(30_000);
  });

  it("trims accidental whitespace around runtime credentials", () => {
    const runtime = loadRuntimeConfig(
      testEnv({
        QQ_APP_ID: "  123456789  ",
        QQ_CLIENT_SECRET: "\n public-example-secret \n",
        DEEPSEEK_API_KEY: "  sk-test  ",
      }),
    );
    expect(runtime.qqAppId).toBe("123456789");
    expect(runtime.qqClientSecret).toBe("public-example-secret");
    expect(runtime.deepseekApiKey).toBe("sk-test");
  });

  it("fails closed for malformed administrator whitelists", () => {
    expect(() =>
      loadRuntimeConfig(testEnv({ ADMIN_WHITELIST: '{"group-a":"not-an-array"}' })),
    ).toThrowError(expect.objectContaining({ code: "configuration" }));
  });

  it("parses a group-scoped administrator whitelist", () => {
    const runtime = loadRuntimeConfig(
      testEnv({ ADMIN_WHITELIST: '{"group-a":["member-1"]}' }),
    );
    expect(runtime.adminWhitelist.get("group-a")?.has("member-1")).toBe(true);
    expect(runtime.adminWhitelist.get("group-b")).toBeUndefined();
  });
});
