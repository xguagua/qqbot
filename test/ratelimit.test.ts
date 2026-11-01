import { describe, expect, it } from "vitest";
import {
  GlobalBudgetStateMachine,
  GroupGuardState,
} from "../src/security/ratelimit";

const limits = {
  groupLimitPerMinute: 3,
  memberCooldownMs: 30_000,
  groupDailyBudgetNanoUsd: 1_000,
};

function groupState(): GroupGuardState {
  return new GroupGuardState(
    {
      events: {},
      windowStartedAt: 0,
      windowCount: 0,
      memberCooldowns: {},
      budgetDay: "2026-10-25",
      budgetSpentNanoUsd: 0,
    },
    limits,
  );
}

describe("per-group guard", () => {
  it("deduplicates an event for its TTL and then expires it", () => {
    const guard = groupState();
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(guard.claimEvent("message-1", now, 1_000)).toBe(true);
    expect(guard.claimEvent("message-1", now + 999, 1_000)).toBe(false);
    expect(guard.claimEvent("message-1", now + 1_001, 1_000)).toBe(true);
  });

  it("enforces member cooldown", () => {
    const guard = groupState();
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(guard.reserveAsk("member-1", 10, now)).toMatchObject({ allowed: true });
    expect(guard.reserveAsk("member-1", 10, now + 29_999)).toMatchObject({
      allowed: false,
      reason: "member_cooldown",
    });
    expect(guard.reserveAsk("member-1", 10, now + 30_001)).toMatchObject({
      allowed: true,
    });
  });

  it("enforces the per-group minute limit across different members", () => {
    const guard = groupState();
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(guard.reserveAsk("m1", 10, now).allowed).toBe(true);
    expect(guard.reserveAsk("m2", 10, now + 1).allowed).toBe(true);
    expect(guard.reserveAsk("m3", 10, now + 2).allowed).toBe(true);
    expect(guard.reserveAsk("m4", 10, now + 3)).toMatchObject({
      allowed: false,
      reason: "group_rate_limit",
    });
    expect(guard.reserveAsk("m1", 10, now + 60_001).allowed).toBe(true);
  });

  it("rejects new work when the group budget is exhausted", () => {
    const guard = groupState();
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(guard.reserveAsk("m1", 900, now).allowed).toBe(true);
    expect(guard.reserveAsk("m2", 101, now + 1)).toMatchObject({
      allowed: false,
      reason: "group_budget",
    });
  });

  it("refunds the unused reservation after settlement", () => {
    const guard = groupState();
    const now = Date.parse("2026-10-25T10:00:00Z");
    const reservation = guard.reserveAsk("m1", 500, now);
    guard.settleAsk(reservation.dayKey, 500, 100);
    expect(guard.state.budgetSpentNanoUsd).toBe(100);
  });

  it("resets the budget on a new UTC day", () => {
    const guard = groupState();
    const first = Date.parse("2026-10-25T23:59:00Z");
    const second = Date.parse("2026-10-26T00:00:01Z");
    expect(guard.reserveAsk("m1", 900, first).allowed).toBe(true);
    expect(guard.reserveAsk("m2", 900, second).allowed).toBe(true);
    expect(guard.state.budgetSpentNanoUsd).toBe(900);
  });
});

describe("global budget", () => {
  it("uses a shared atomic cap", () => {
    const budget = new GlobalBudgetStateMachine(
      { dayKey: "2026-10-25", spentNanoUsd: 0 },
      100,
    );
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(budget.reserve(60, now).allowed).toBe(true);
    expect(budget.reserve(41, now + 1)).toMatchObject({
      allowed: false,
      reason: "group_budget",
    });
  });
});
