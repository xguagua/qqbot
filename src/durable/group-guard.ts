import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";
import { AppError } from "../errors";
import {
  GroupGuardState,
  emptyGuardState,
  normalizeGuardState,
} from "../security/ratelimit";
import { isNonEmptyString, jsonResponse, readJsonObject } from "../util";

export class GroupGuard extends DurableObject<Env> {
  readonly #state: DurableObjectState;
  readonly #ready: Promise<void>;
  #machine: GroupGuardState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    this.#ready = this.#state.blockConcurrencyWhile(async () => {
      const stored = await this.#state.storage.get<unknown>("state");
      this.#machine = new GroupGuardState(
        stored === undefined ? emptyGuardState() : normalizeGuardState(stored),
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
      if (path !== "/claim") {
        return jsonResponse({ error: "not_found" }, 404);
      }
      const { value } = await readJsonObject(request, 4_096);
      if (!isNonEmptyString(value.messageId) || value.messageId.length > 512) {
        throw new AppError("invalid_request", "Invalid messageId", 400);
      }
      const claimed = this.#machine.claimEvent(value.messageId, Date.now());
      if (claimed) {
        await this.#state.storage.put("state", this.#machine.state);
      }
      return jsonResponse({ claimed });
    } catch (error) {
      if (error instanceof AppError) {
        return jsonResponse({ error: error.code }, error.status);
      }
      return jsonResponse({ error: "internal" }, 500);
    }
  }
}
