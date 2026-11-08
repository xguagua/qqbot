import { EVENT_DEDUPE_TTL_MS } from "../config";
import { AppError } from "../errors";
import { asRecord, isNonEmptyString } from "../util";

const MAX_STORED_EVENTS = 10_000;

export interface GuardState {
  events: Record<string, number>;
}

export function emptyGuardState(): GuardState {
  return { events: {} };
}

export function normalizeGuardState(value: unknown): GuardState {
  const record = asRecord(value);
  const events: Record<string, number> = {};
  if (asRecord(record?.events) !== null) {
    for (const [key, expiresAt] of Object.entries(
      record!.events as Record<string, unknown>,
    )) {
      if (
        isNonEmptyString(key) &&
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt)
      ) {
        events[key] = expiresAt;
      }
    }
  }
  return { events };
}

export class GroupGuardState {
  readonly state: GuardState;

  constructor(state: GuardState) {
    this.state = state;
  }

  claimEvent(messageId: string, now: number): boolean {
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
    this.state.events[messageId] = now + EVENT_DEDUPE_TTL_MS;
    return true;
  }
}

export interface EventGuard {
  claimEvent(messageId: string): Promise<boolean>;
}

async function postDurableObject(
  namespace: DurableObjectNamespace,
  name: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = namespace.get(namespace.idFromName(name));
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

export class DurableEventGuard implements EventGuard {
  readonly #namespace: DurableObjectNamespace;
  readonly #groupOpenid: string;

  constructor(namespace: DurableObjectNamespace, groupOpenid: string) {
    this.#namespace = namespace;
    this.#groupOpenid = groupOpenid;
  }

  async claimEvent(messageId: string): Promise<boolean> {
    const result = await postDurableObject(
      this.#namespace,
      this.#groupOpenid,
      "/claim",
      { messageId },
    );
    if (typeof result.claimed !== "boolean") {
      throw new AppError(
        "storage_unavailable",
        "Durable Object claim response is invalid",
      );
    }
    return result.claimed;
  }
}
