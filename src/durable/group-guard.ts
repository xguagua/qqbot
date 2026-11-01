import { DurableObject } from "cloudflare:workers";
import {
  MAX_RESERVATION_NANO_USD,
  loadGroupGuardLimits,
  type Env,
} from "../config";
import { AppError } from "../errors";
import { GroupGuardState, normalizeGuardState } from "../security/ratelimit";
import { isNonEmptyString, jsonResponse, readJsonObject } from "../util";

function positiveCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class GroupGuard extends DurableObject<Env> {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #ready: Promise<void>;
  #machine: GroupGuardState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#ready = this.#state.blockConcurrencyWhile(async () => {
      const stored = await this.#state.storage.get<unknown>("state");
      const now = Date.now();
      this.#machine = new GroupGuardState(
        normalizeGuardState(stored, now),
        loadGroupGuardLimits(this.#env),
      );
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.#ready;
    if (request.method !== "POST" || this.#machine === null) {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    try {
      const path = new URL(request.url).pathname;
      if (path === "/claim") {
        return await this.#claim(request);
      }
      if (path === "/reserve") {
        return await this.#reserve(request);
      }
      if (path === "/settle") {
        return await this.#settle(request);
      }
      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof AppError) {
        return jsonResponse({ error: error.code }, error.status);
      }
      return jsonResponse({ error: "internal" }, 500);
    }
  }

  async #claim(request: Request): Promise<Response> {
    const { value } = await readJsonObject(request, 4_096);
    if (!isNonEmptyString(value.messageId) || value.messageId.length > 512) {
      throw new AppError("invalid_request", "Invalid messageId", 400);
    }
    const claimed = this.#machine!.claimEvent(value.messageId, Date.now());
    if (claimed) {
      await this.#persist();
    }
    return jsonResponse({ claimed });
  }

  async #reserve(request: Request): Promise<Response> {
    const { value } = await readJsonObject(request, 4_096);
    if (!isNonEmptyString(value.memberOpenid) || !positiveCost(value.reservedNanoUsd)) {
      throw new AppError("invalid_request", "Invalid reservation", 400);
    }
    if (value.reservedNanoUsd > MAX_RESERVATION_NANO_USD) {
      throw new AppError("invalid_request", "Reservation is too large", 400);
    }

    const result = this.#machine!.reserveAsk(
      value.memberOpenid,
      value.reservedNanoUsd,
      Date.now(),
    );
    await this.#persist();
    return jsonResponse(result);
  }

  async #settle(request: Request): Promise<Response> {
    const { value } = await readJsonObject(request, 4_096);
    if (
      !isNonEmptyString(value.dayKey) ||
      !positiveCost(value.reservedNanoUsd) ||
      !nonNegativeCost(value.actualNanoUsd)
    ) {
      throw new AppError("invalid_request", "Invalid settlement", 400);
    }
    if (
      value.reservedNanoUsd > MAX_RESERVATION_NANO_USD ||
      value.actualNanoUsd > value.reservedNanoUsd
    ) {
      throw new AppError("invalid_request", "Invalid settlement amount", 400);
    }
    this.#machine!.settleAsk(
      value.dayKey,
      value.reservedNanoUsd,
      value.actualNanoUsd,
    );
    await this.#persist();
    return jsonResponse({ settled: true });
  }

  async #persist(): Promise<void> {
    if (this.#machine !== null) {
      await this.#state.storage.put("state", this.#machine.state);
    }
  }
}
