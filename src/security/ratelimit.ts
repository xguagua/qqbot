import { EVENT_DEDUPE_TTL_MS, type GroupGuardLimits } from "../config";
import { AppError } from "../errors";
import { asRecord, isNonEmptyString } from "../util";

const MAX_STORED_EVENTS = 10_000;

export interface GuardState {
  events: Record<string, number>;
  windowStartedAt: number;
  windowCount: number;
  memberCooldowns: Record<string, number>;
  budgetDay: string;
  budgetSpentNanoUsd: number;
}

export type ReservationDenial = "group_rate_limit" | "member_cooldown" | "group_budget";

export interface ReservationResult {
  allowed: boolean;
  reason?: ReservationDenial;
  dayKey: string;
}

export interface EventGuard {
  claimEvent(messageId: string): Promise<boolean>;
  reserveAsk(memberOpenid: string, reservedNanoUsd: number): Promise<ReservationResult>;
  settleAsk(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void>;
}

export interface GlobalBudget {
  reserve(reservedNanoUsd: number): Promise<ReservationResult>;
  settle(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void>;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyGuardState(now: number): GuardState {
  return {
    events: {},
    windowStartedAt: Math.floor(now / 60_000) * 60_000,
    windowCount: 0,
    memberCooldowns: {},
    budgetDay: utcDay(now),
    budgetSpentNanoUsd: 0,
  };
}

export function normalizeGuardState(value: unknown, now: number): GuardState {
  const record = asRecord(value);
  if (record === null) {
    return emptyGuardState(now);
  }

  const fallback = emptyGuardState(now);
  const events: Record<string, number> = {};
  if (asRecord(record.events) !== null) {
    for (const [key, expiresAt] of Object.entries(record.events as Record<string, unknown>)) {
      if (isNonEmptyString(key) && typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
        events[key] = expiresAt;
      }
    }
  }

  const memberCooldowns: Record<string, number> = {};
  if (asRecord(record.memberCooldowns) !== null) {
    for (const [key, availableAt] of Object.entries(
      record.memberCooldowns as Record<string, unknown>,
    )) {
      if (isNonEmptyString(key) && typeof availableAt === "number" && Number.isFinite(availableAt)) {
        memberCooldowns[key] = availableAt;
      }
    }
  }

  return {
    events,
    windowStartedAt:
      typeof record.windowStartedAt === "number" && Number.isFinite(record.windowStartedAt)
        ? record.windowStartedAt
        : fallback.windowStartedAt,
    windowCount:
      typeof record.windowCount === "number" &&
      Number.isSafeInteger(record.windowCount) &&
      record.windowCount >= 0
        ? record.windowCount
        : 0,
    memberCooldowns,
    budgetDay: isNonEmptyString(record.budgetDay) ? record.budgetDay : fallback.budgetDay,
    budgetSpentNanoUsd:
      typeof record.budgetSpentNanoUsd === "number" &&
      Number.isSafeInteger(record.budgetSpentNanoUsd) &&
      record.budgetSpentNanoUsd >= 0
        ? record.budgetSpentNanoUsd
        : 0,
  };
}

export class GroupGuardState {
  state: GuardState;
  readonly #limits: GroupGuardLimits;

  constructor(state: GuardState, limits: GroupGuardLimits) {
    this.state = state;
    this.#limits = limits;
  }

  claimEvent(messageId: string, now: number, ttlMs = EVENT_DEDUPE_TTL_MS): boolean {
    for (const [eventId, expiresAt] of Object.entries(this.state.events)) {
      if (expiresAt <= now) {
        delete this.state.events[eventId];
      }
    }
    if (this.state.events[messageId] !== undefined) {
      return false;
    }
    if (Object.keys(this.state.events).length >= MAX_STORED_EVENTS) {
      return false;
    }
    this.state.events[messageId] = now + ttlMs;
    return true;
  }

  reserveAsk(memberOpenid: string, reservedNanoUsd: number, now: number): ReservationResult {
    const dayKey = utcDay(now);
    if (this.state.budgetDay !== dayKey) {
      this.state.budgetDay = dayKey;
      this.state.budgetSpentNanoUsd = 0;
    }

    if (this.state.budgetSpentNanoUsd + reservedNanoUsd > this.#limits.groupDailyBudgetNanoUsd) {
      return { allowed: false, reason: "group_budget", dayKey };
    }

    const memberAvailableAt = this.state.memberCooldowns[memberOpenid] ?? 0;
    if (memberAvailableAt > now) {
      return { allowed: false, reason: "member_cooldown", dayKey };
    }

    const minuteStart = Math.floor(now / 60_000) * 60_000;
    if (this.state.windowStartedAt !== minuteStart) {
      this.state.windowStartedAt = minuteStart;
      this.state.windowCount = 0;
    }
    if (this.state.windowCount >= this.#limits.groupLimitPerMinute) {
      return { allowed: false, reason: "group_rate_limit", dayKey };
    }

    this.state.windowCount += 1;
    this.state.memberCooldowns[memberOpenid] = now + this.#limits.memberCooldownMs;
    this.state.budgetSpentNanoUsd += reservedNanoUsd;

    for (const [member, availableAt] of Object.entries(this.state.memberCooldowns)) {
      if (availableAt < now - 86_400_000) {
        delete this.state.memberCooldowns[member];
      }
    }
    return { allowed: true, dayKey };
  }

  settleAsk(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): void {
    if (this.state.budgetDay !== dayKey) {
      return;
    }
    const boundedActual = Math.max(0, Math.min(reservedNanoUsd, actualNanoUsd));
    this.state.budgetSpentNanoUsd = Math.max(
      0,
      this.state.budgetSpentNanoUsd - reservedNanoUsd + boundedActual,
    );
  }
}

export interface GlobalBudgetState {
  dayKey: string;
  spentNanoUsd: number;
}

export function normalizeGlobalBudgetState(value: unknown, now: number): GlobalBudgetState {
  const record = asRecord(value);
  return {
    dayKey: isNonEmptyString(record?.dayKey) ? record.dayKey : utcDay(now),
    spentNanoUsd:
      typeof record?.spentNanoUsd === "number" &&
      Number.isSafeInteger(record.spentNanoUsd) &&
      record.spentNanoUsd >= 0
        ? record.spentNanoUsd
        : 0,
  };
}

export class GlobalBudgetStateMachine {
  state: GlobalBudgetState;
  readonly #limit: number;

  constructor(state: GlobalBudgetState, limit: number) {
    this.state = state;
    this.#limit = limit;
  }

  reserve(reservedNanoUsd: number, now: number): ReservationResult {
    const dayKey = utcDay(now);
    if (this.state.dayKey !== dayKey) {
      this.state.dayKey = dayKey;
      this.state.spentNanoUsd = 0;
    }
    if (this.state.spentNanoUsd + reservedNanoUsd > this.#limit) {
      return { allowed: false, reason: "group_budget", dayKey };
    }
    this.state.spentNanoUsd += reservedNanoUsd;
    return { allowed: true, dayKey };
  }

  settle(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): void {
    if (this.state.dayKey !== dayKey) {
      return;
    }
    const boundedActual = Math.max(0, Math.min(reservedNanoUsd, actualNanoUsd));
    this.state.spentNanoUsd = Math.max(
      0,
      this.state.spentNanoUsd - reservedNanoUsd + boundedActual,
    );
  }
}

async function postDurableObject(
  namespace: DurableObjectNamespace,
  name: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const id = namespace.idFromName(name);
  const stub = namespace.get(id);
  const response = await stub.fetch(`https://durable-object${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new AppError("storage_unavailable", "Durable Object request failed");
  }
  const payload: unknown = await response.json();
  const record = asRecord(payload);
  if (record === null) {
    throw new AppError("storage_unavailable", "Durable Object response is invalid");
  }
  return record;
}

function parseReservation(record: Record<string, unknown>): ReservationResult {
  if (
    typeof record.allowed !== "boolean" ||
    !isNonEmptyString(record.dayKey) ||
    (record.reason !== undefined &&
      record.reason !== "group_rate_limit" &&
      record.reason !== "member_cooldown" &&
      record.reason !== "group_budget")
  ) {
    throw new AppError("storage_unavailable", "Durable Object reservation is invalid");
  }
  if (record.allowed) {
    return { allowed: true, dayKey: record.dayKey };
  }
  if (record.reason === undefined) {
    throw new AppError("storage_unavailable", "Durable Object denial reason is missing");
  }
  return {
    allowed: false,
    reason: record.reason as ReservationDenial,
    dayKey: record.dayKey,
  };
}

export class DurableEventGuard implements EventGuard {
  readonly #namespace: DurableObjectNamespace;
  readonly #groupOpenid: string;

  constructor(namespace: DurableObjectNamespace, groupOpenid: string) {
    this.#namespace = namespace;
    this.#groupOpenid = groupOpenid;
  }

  async claimEvent(messageId: string): Promise<boolean> {
    const result = await postDurableObject(this.#namespace, this.#groupOpenid, "/claim", {
      messageId,
    });
    if (typeof result.claimed !== "boolean") {
      throw new AppError("storage_unavailable", "Durable Object claim response is invalid");
    }
    return result.claimed;
  }

  async reserveAsk(memberOpenid: string, reservedNanoUsd: number): Promise<ReservationResult> {
    return parseReservation(
      await postDurableObject(this.#namespace, this.#groupOpenid, "/reserve", {
        memberOpenid,
        reservedNanoUsd,
      }),
    );
  }

  async settleAsk(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void> {
    await postDurableObject(this.#namespace, this.#groupOpenid, "/settle", {
      dayKey,
      reservedNanoUsd,
      actualNanoUsd,
    });
  }
}

export class DurableGlobalBudget implements GlobalBudget {
  readonly #namespace: DurableObjectNamespace;

  constructor(namespace: DurableObjectNamespace) {
    this.#namespace = namespace;
  }

  async reserve(reservedNanoUsd: number): Promise<ReservationResult> {
    return parseReservation(
      await postDurableObject(this.#namespace, "global", "/reserve", { reservedNanoUsd }),
    );
  }

  async settle(dayKey: string, reservedNanoUsd: number, actualNanoUsd: number): Promise<void> {
    await postDurableObject(this.#namespace, "global", "/settle", {
      dayKey,
      reservedNanoUsd,
      actualNanoUsd,
    });
  }
}
