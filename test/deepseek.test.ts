import { describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/ai/deepseek";
import { DeepSeekError } from "../src/errors";

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "  最终回答  " } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("DeepSeek client", () => {
  it("sends one independent request with only system and user messages", async () => {
    let capturedRequest: RequestInit | undefined;
    const client = new DeepSeekClient({
      apiKey: "secret-api-key",
      fetch: async (_input, init) => {
        capturedRequest = init;
        return successResponse();
      },
    });

    const result = await client.complete({
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
      systemPrompt: "SYSTEM_ONLY",
      question: "USER_ONLY",
      maxOutputTokens: 321,
    });

    expect(result).toEqual({
      content: "最终回答",
      usage: { promptTokens: 123, completionTokens: 45 },
    });
    const body = JSON.parse(String(capturedRequest?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "SYSTEM_ONLY" },
        { role: "user", content: "USER_ONLY" },
      ],
      reasoning_effort: "high",
      max_tokens: 321,
      stream: false,
    });
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("temperature");
    const headers = new Headers(capturedRequest?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-api-key");
  });

  it("retries a retryable 5xx response at most once", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const client = new DeepSeekClient({
      apiKey: "key",
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 503 });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(
      client.complete({
        model: "deepseek-flash",
        reasoningEffort: "low",
        systemPrompt: "s",
        question: "q",
        maxOutputTokens: 10,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("preserves prior user and assistant chat turns in order", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new DeepSeekClient({
      apiKey: "key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return successResponse();
      },
    });
    await client.complete({
      model: "deepseek-flash",
      reasoningEffort: "none",
      systemPrompt: "FIREFLY",
      question: "current",
      history: [
        { role: "user", content: "previous user" },
        { role: "assistant", content: "previous assistant" },
      ],
      maxOutputTokens: 10,
    });
    expect(body?.messages).toEqual([
      { role: "system", content: "FIREFLY" },
      { role: "user", content: "previous user" },
      { role: "assistant", content: "previous assistant" },
      { role: "user", content: "current" },
    ]);
  });

  it("maps 429 to a stable retryable error", async () => {
    let calls = 0;
    const client = new DeepSeekClient({
      apiKey: "key",
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 429 });
      },
      sleep: async () => {},
    });
    await expect(
      client.complete({
        model: "deepseek-flash",
        reasoningEffort: "none",
        systemPrompt: "s",
        question: "q",
        maxOutputTokens: 10,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(calls).toBe(2);
  });

  it("maps a timeout and marks the request as potentially billable", async () => {
    const client = new DeepSeekClient({
      apiKey: "key",
      fetch: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    const promise = client.complete({
      model: "deepseek-flash",
      reasoningEffort: "low",
      systemPrompt: "s",
      question: "q",
      maxOutputTokens: 10,
    });
    await expect(promise).rejects.toMatchObject({
      code: "upstream_timeout",
      requestMayBeBillable: true,
    });
  });

  it.each([
    ["empty content", { choices: [{ message: { content: "   " } }] }],
    ["missing choices", { choices: [] }],
    ["missing usage", { usage: undefined }],
  ])("rejects an empty or malformed response: %s", async (_label, payload) => {
    const client = new DeepSeekClient({
      apiKey: "key",
      fetch: async () => successResponse(payload),
    });
    await expect(
      client.complete({
        model: "deepseek-flash",
        reasoningEffort: "low",
        systemPrompt: "s",
        question: "q",
        maxOutputTokens: 10,
      }),
    ).rejects.toBeInstanceOf(DeepSeekError);
  });

  it("fails locally when the API key is absent", async () => {
    const client = new DeepSeekClient({ apiKey: "" });
    await expect(
      client.complete({
        model: "deepseek-flash",
        reasoningEffort: "low",
        systemPrompt: "s",
        question: "q",
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: "configuration" });
  });
});
