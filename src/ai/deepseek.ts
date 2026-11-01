import { AI_TIMEOUT_MS, type DeepSeekModel, type ReasoningEffort } from "../config";
import { AppError, DeepSeekError } from "../errors";
import type { DeepSeekUsage } from "./pricing";
import { asRecord } from "../util";
import type { ChatMessage } from "../chat/types";
import type { LoadedAttachment } from "../files/attachments";

export interface DeepSeekCompletionRequest {
  model: DeepSeekModel;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  question: string;
  history?: readonly ChatMessage[];
  attachments?: readonly LoadedAttachment[];
  maxOutputTokens: number;
  timeoutMs?: number;
}

export interface DeepSeekCompletion {
  content: string;
  usage: DeepSeekUsage;
}

export interface AIClient {
  complete(request: DeepSeekCompletionRequest): Promise<DeepSeekCompletion>;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  baseUrl?: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseUsage(value: unknown): DeepSeekUsage | null {
  const usage = asRecord(value);
  if (usage === null) {
    return null;
  }
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (
    typeof promptTokens !== "number" ||
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== "number" ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return null;
  }
  return { promptTokens, completionTokens };
}

function errorForStatus(status: number): DeepSeekError {
  if (status === 401) {
    return new DeepSeekError("configuration", "DeepSeek authentication failed");
  }
  if (status === 402) {
    return new DeepSeekError("budget_exhausted", "DeepSeek balance is insufficient");
  }
  if (status === 422) {
    return new DeepSeekError("invalid_request", "DeepSeek rejected the request");
  }
  if (status === 429) {
    return new DeepSeekError("rate_limited", "DeepSeek rate limit reached", {
      retryable: true,
    });
  }
  if (status >= 500) {
    return new DeepSeekError("upstream_unavailable", "DeepSeek is temporarily unavailable", {
      retryable: true,
    });
  }
  return new DeepSeekError("upstream_unavailable", "DeepSeek request failed");
}

export class DeepSeekClient implements AIClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #endpoint: string;

  constructor(options: DeepSeekClientOptions) {
    this.#apiKey = options.apiKey;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#endpoint = `${options.baseUrl ?? "https://api.deepseek.com"}/chat/completions`;
  }

  async complete(request: DeepSeekCompletionRequest): Promise<DeepSeekCompletion> {
    if (this.#apiKey.length === 0) {
      throw new AppError("configuration", "DEEPSEEK_API_KEY is not configured");
    }

    const timeoutMs = request.timeoutMs ?? AI_TIMEOUT_MS;
    const deadline = this.#now() + timeoutMs;
    let lastError: DeepSeekError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        break;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      const userContent =
        request.attachments !== undefined && request.attachments.length > 0
          ? [
              { type: "text", text: request.question },
              ...request.attachments.map((attachment) =>
                attachment.kind === "image"
                  ? {
                      type: "image_url",
                      image_url: { url: attachment.dataUrl, detail: "low" },
                    }
                  : {
                      type: "file",
                      file_data: attachment.dataUrl,
                      filename: attachment.filename,
                    },
              ),
            ]
          : request.question;
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            messages: [
              { role: "system", content: request.systemPrompt },
              ...(request.history ?? []).map((message) => ({
                role: message.role,
                content: message.content,
              })),
              { role: "user", content: userContent },
            ],
            reasoning_effort: request.reasoningEffort,
            max_tokens: request.maxOutputTokens,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new DeepSeekError("upstream_timeout", "DeepSeek request timed out", {
            requestMayBeBillable: true,
          });
        }
        lastError = new DeepSeekError("upstream_unavailable", "DeepSeek network request failed", {
          retryable: attempt === 0,
          requestMayBeBillable: true,
        });
        if (attempt === 0) {
          const backoff = Math.min(250, Math.max(0, deadline - this.#now()));
          if (backoff > 0) {
            await this.#sleep(backoff);
          }
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const mapped = errorForStatus(response.status);
        lastError = mapped;
        if (mapped.retryable && attempt === 0) {
          const backoff = Math.min(250, Math.max(0, deadline - this.#now()));
          if (backoff > 0) {
            await this.#sleep(backoff);
          }
          continue;
        }
        throw mapped;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new DeepSeekError("response_empty", "DeepSeek returned invalid JSON", {
          requestMayBeBillable: true,
        });
      }

      const record = asRecord(payload);
      const choices = record?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new DeepSeekError("response_empty", "DeepSeek returned no choices", {
          requestMayBeBillable: true,
        });
      }
      const firstChoice = asRecord(choices[0]);
      const message = asRecord(firstChoice?.message);
      if (typeof message?.content !== "string" || message.content.trim().length === 0) {
        throw new DeepSeekError("response_empty", "DeepSeek returned empty content", {
          requestMayBeBillable: true,
        });
      }

      const usage = parseUsage(record?.usage);
      if (usage === null) {
        throw new DeepSeekError("response_empty", "DeepSeek response omitted usage", {
          requestMayBeBillable: true,
        });
      }

      return { content: message.content.trim(), usage };
    }

    if (lastError !== null) {
      throw lastError;
    }
    throw new DeepSeekError("upstream_timeout", "DeepSeek request timed out", {
      requestMayBeBillable: true,
    });
  }
}
