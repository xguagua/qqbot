import { QQ_TIMEOUT_MS } from "../config";
import { AppError } from "../errors";
import { asRecord, isNonEmptyString } from "../util";

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

export interface QQTokenProviderOptions {
  appId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
}

function safeErrorToken(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  return String(value).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

function tokenNetworkDiagnostic(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "qq_token_timeout";
  }

  const name =
    error instanceof Error ? safeErrorToken(error.name) || "error" : "unknown";
  const cause =
    error instanceof Error
      ? (error as Error & { cause?: unknown }).cause
      : undefined;
  const causeName =
    cause instanceof Error ? safeErrorToken(cause.name) : "";
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause
      ? safeErrorToken((cause as { code?: unknown }).code)
      : "";
  const suffix = [causeName, causeCode].filter(Boolean).join("_");
  return `qq_token_network_${name}${suffix ? `_${suffix}` : ""}`;
}

export class QQTokenProvider implements TokenProvider {
  readonly #appId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #endpoint: string;
  #accessToken = "";
  #expiresAt = 0;
  #pending: Promise<string> | null = null;

  constructor(options: QQTokenProviderOptions) {
    this.#appId = options.appId;
    this.#clientSecret = options.clientSecret;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? QQ_TIMEOUT_MS;
    this.#endpoint = `${options.baseUrl ?? "https://api.bot.qq.com"}/app/getAppAccessToken`;
  }

  getAccessToken(): Promise<string> {
    if (this.#accessToken && this.#now() < this.#expiresAt) {
      return Promise.resolve(this.#accessToken);
    }
    if (this.#pending !== null) {
      return this.#pending;
    }

    const pending = this.#refresh();
    this.#pending = pending;
    void pending.then(
      () => {
        if (this.#pending === pending) {
          this.#pending = null;
        }
      },
      () => {
        if (this.#pending === pending) {
          this.#pending = null;
        }
      },
    );
    return pending;
  }

  invalidate(): void {
    this.#accessToken = "";
    this.#expiresAt = 0;
  }

  async #refresh(): Promise<string> {
    let response: Response | undefined;
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: this.#appId, clientSecret: this.#clientSecret }),
          signal: controller.signal,
        });
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (response === undefined) {
      throw new AppError(
        "upstream_unavailable",
        "Unable to request QQ access token",
        500,
        tokenNetworkDiagnostic(lastNetworkError),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError(
        "upstream_unavailable",
        "QQ token endpoint returned invalid JSON",
        500,
        "qq_token_invalid_json",
      );
    }

    const record = asRecord(payload);
    if (!response.ok) {
      throw new AppError(
        "upstream_unavailable",
        "QQ token endpoint failed",
        500,
        `qq_token_http_${response.status}`,
      );
    }
    if (record?.code !== undefined && record.code !== 0) {
      const safeCode = String(record.code).replace(/[^0-9]/g, "").slice(0, 16) || "unknown";
      throw new AppError(
        "upstream_unavailable",
        "QQ token endpoint returned a business error",
        500,
        `qq_token_business_${safeCode}`,
      );
    }
    if (!isNonEmptyString(record?.access_token)) {
      throw new AppError(
        "upstream_unavailable",
        "QQ token response omitted access_token",
        500,
        "qq_token_missing_access_token",
      );
    }

    const rawExpiresIn = record.expires_in;
    const expiresIn =
      typeof rawExpiresIn === "number"
        ? rawExpiresIn
        : typeof rawExpiresIn === "string"
          ? Number.parseInt(rawExpiresIn, 10)
          : Number.NaN;
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AppError(
        "upstream_unavailable",
        "QQ token response had invalid expiry",
        500,
        "qq_token_invalid_expiry",
      );
    }

    this.#accessToken = record.access_token;
    this.#expiresAt = this.#now() + Math.max(0, expiresIn - 60) * 1_000;
    return this.#accessToken;
  }
}
