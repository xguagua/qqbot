import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";
import { jsonResponse } from "../util";

// Retained as an empty Durable Object so the existing v1 deployment migration
// and production binding remain valid after reducing this branch's scope.
export class GlobalBudget extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return jsonResponse({ error: "not_found" }, 404);
  }
}
