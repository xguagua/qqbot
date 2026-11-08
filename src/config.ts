import { AppError } from "./errors";
import { isNonEmptyString } from "./util";

export const MAX_AT_MESSAGE_CHARS = 500;
export const MAX_QUOTED_CONTEXT_CHARS = 600;
export const MAX_REPLY_CHARS = 1_500;
export const QQ_TIMEOUT_MS = 7_000;
export const REPLY_WINDOW_MS = 5 * 60_000;
export const REPLY_WINDOW_SAFETY_MS = 15_000;
export const EVENT_DEDUPE_TTL_MS = 10 * 60_000;

export interface AppBindings {
  GROUP_GUARD: DurableObjectNamespace;
  GLOBAL_BUDGET?: DurableObjectNamespace;
  QQ_APP_ID?: string;
  QQ_CLIENT_SECRET?: string;
  GIT_COMMIT_SHA?: string;
  DEPLOYED_AT?: string;
}

export type Env = AppBindings;

export interface RuntimeConfig {
  qqAppId: string;
  qqClientSecret: string;
  gitCommitSha: string;
  deployedAt: string;
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new AppError("configuration", `${name} is not configured`);
  }
  return value.trim();
}

export function loadRuntimeConfig(env: AppBindings): RuntimeConfig {
  return {
    qqAppId: requiredSecret(env.QQ_APP_ID, "QQ_APP_ID"),
    qqClientSecret: requiredSecret(env.QQ_CLIENT_SECRET, "QQ_CLIENT_SECRET"),
    gitCommitSha: env.GIT_COMMIT_SHA?.trim() || "unknown",
    deployedAt: env.DEPLOYED_AT?.trim() || "unknown",
  };
}
