import { DurableObject } from "cloudflare:workers";
import {
  MAX_RESERVATION_NANO_USD,
  loadGlobalBudgetLimit,
  type Env,
} from "../config";
import { AppError } from "../errors";
import {
  GlobalBudgetStateMachine,
  normalizeGlobalBudgetState,
} from "../security/ratelimit";
import { isNonEmptyString, jsonResponse, readJsonObject } from "../util";

function positiveCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeCost(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class GlobalBudget extends DurableObject<Env> {
  readonly #state: DurableObjectState;
  readonly #env: Env;
  readonly #ready: Promise<void>;
  #machine: GlobalBudgetStateMachine | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#ready = this.#state.blockConcurrencyWhile(async () => {
      const stored = await this.#state.storage.get<unknown>("state");
      this.#machine = new GlobalBudgetStateMachine(
        normalizeGlobalBudgetState(stored, Date.now()),
        loadGlobalBudgetLimit(this.#env),
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

  async #reserve(request: Request): Promise<Response> {
    const { value } = await readJsonObject(request, 4_096);
    if (
      !positiveCost(value.reservedNanoUsd) ||
      value.reservedNanoUsd > MAX_RESERVATION_NANO_USD
    ) {
      throw new AppError("invalid_request", "Invalid reservation", 400);
    }
    const result = this.#machine!.reserve(value.reservedNanoUsd, Date.now());
    await this.#persist();
    return jsonResponse(result);
  }

  async #settle(request: Request): Promise<Response> {
    const { value } = await readJsonObject(request, 4_096);
    if (
      !isNonEmptyString(value.dayKey) ||
      !positiveCost(value.reservedNanoUsd) ||
      !nonNegativeCost(value.actualNanoUsd) ||
      value.reservedNanoUsd > MAX_RESERVATION_NANO_USD ||
      value.actualNanoUsd > value.reservedNanoUsd
    ) {
      throw new AppError("invalid_request", "Invalid settlement", 400);
    }
    this.#machine!.settle(value.dayKey, value.reservedNanoUsd, value.actualNanoUsd);
    await this.#persist();
    return jsonResponse({ settled: true });
  }

  async #persist(): Promise<void> {
    if (this.#machine !== null) {
      await this.#state.storage.put("state", this.#machine.state);
    }
  }
}
