import { describe, expect, it } from "vitest";
import { GroupGuardState } from "../../src/security/ratelimit";

describe("event deduplication", () => {
  it("claims each message once within the TTL", () => {
    const guard = new GroupGuardState({ events: {} });
    expect(guard.claimEvent("message-1", 1_000)).toBe(true);
    expect(guard.claimEvent("message-1", 2_000)).toBe(false);
    expect(guard.claimEvent("message-2", 2_000)).toBe(true);
  });
});
