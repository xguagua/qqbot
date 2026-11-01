import { describe, expect, it } from "vitest";
import { QQTokenProvider, type TokenProvider } from "../src/qq/auth";
import { QQApiClient } from "../src/qq/client";

function tokenResponse(expiresIn = "7200"): Response {
  return new Response(JSON.stringify({ access_token: "cached-token", expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("QQ access token provider", () => {
  it("deduplicates concurrent refreshes and caches the token", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new QQTokenProvider({
      appId: "app",
      clientSecret: "secret",
      now: () => 1_000,
      fetch: async () => {
        calls += 1;
        await gate;
        return tokenResponse();
      },
    });

    const first = provider.getAccessToken();
    const second = provider.getAccessToken();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "cached-token",
      "cached-token",
    ]);
    await expect(provider.getAccessToken()).resolves.toBe("cached-token");
    expect(calls).toBe(1);
  });

  it("invokes the native fetch function without the provider as receiver", async () => {
    let receiver: unknown = "not-called";
    const provider = new QQTokenProvider({
      appId: "app",
      clientSecret: "secret",
      fetch: function (this: unknown) {
        receiver = this;
        return Promise.resolve(tokenResponse());
      },
    });
    await expect(provider.getAccessToken()).resolves.toBe("cached-token");
    expect(receiver).toBeUndefined();
  });

  it("refreshes within sixty seconds of expiry", async () => {
    let now = 0;
    let calls = 0;
    const provider = new QQTokenProvider({
      appId: "app",
      clientSecret: "secret",
      now: () => now,
      fetch: async () => {
        calls += 1;
        return tokenResponse();
      },
    });
    await provider.getAccessToken();
    now = 7_139_999;
    await provider.getAccessToken();
    expect(calls).toBe(1);
    now = 7_140_000;
    await provider.getAccessToken();
    expect(calls).toBe(2);
  });

  it("does not expose a business error as a token", async () => {
    const provider = new QQTokenProvider({
      appId: "app",
      clientSecret: "secret",
      fetch: async () =>
        new Response(JSON.stringify({ code: 100016, message: "bad secret" }), {
          status: 200,
        }),
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "upstream_unavailable",
      diagnosticCode: "qq_token_business_100016",
    });
  });

  it("classifies QQ token transport failures without exposing details", async () => {
    const provider = new QQTokenProvider({
      appId: "app",
      clientSecret: "secret",
      fetch: async () => {
        throw Object.assign(new TypeError("network failed"), {
          cause: { code: "ECONNRESET" },
        });
      },
    });
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "upstream_unavailable",
      diagnosticCode: "qq_token_network_TypeError_ECONNRESET",
    });
  });
});

describe("QQ message client", () => {
  const tokens: TokenProvider = {
    async getAccessToken() {
      return "token";
    },
    invalidate() {},
  };

  it("sends the required passive reply body", async () => {
    let request: { url: string; init?: RequestInit | undefined } | undefined;
    const client = new QQApiClient({
      tokens,
      now: () => 1_000,
      fetch: async (input, init) => {
        request = { url: String(input), init };
        return new Response(JSON.stringify({ id: "reply-id" }), { status: 200 });
      },
    });

    await client.sendText({
      groupOpenid: "group/openid",
      messageId: "message-id",
      eventTimestampMs: 999,
      content: "pong",
      sequence: 1,
    });
    expect(request?.url).toBe(
      "https://api.bot.qq.com/v2/groups/group%2Fopenid/messages",
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      msg_type: 0,
      content: "pong",
      msg_id: "message-id",
      msg_seq: 1,
    });
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("QQBot token");
  });

  it("surfaces a business error in HTTP 200", async () => {
    const client = new QQApiClient({
      tokens,
      fetch: async () =>
        new Response(JSON.stringify({ code: 40054005, message: "deduplicated" }), {
          status: 200,
        }),
    });
    await expect(
      client.sendText({
        groupOpenid: "group",
        messageId: "message",
        eventTimestampMs: Date.now(),
        content: "pong",
        sequence: 1,
      }),
    ).rejects.toMatchObject({
      code: "qq_business_error",
      diagnosticCode: "qq_message_business_40054005",
    });
  });

  it("does not send outside the passive reply window", async () => {
    let called = false;
    const client = new QQApiClient({
      tokens,
      now: () => 1_000_000,
      fetch: async () => {
        called = true;
        return new Response(JSON.stringify({ id: "id" }), { status: 200 });
      },
    });
    await expect(
      client.sendText({
        groupOpenid: "group",
        messageId: "message",
        eventTimestampMs: 0,
        content: "pong",
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: "reply_window_expired" });
    expect(called).toBe(false);
  });

  it("maps a transport timeout to a stable upstream error", async () => {
    const client = new QQApiClient({
      tokens,
      fetch: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    await expect(
      client.sendText({
        groupOpenid: "group",
        messageId: "message",
        eventTimestampMs: Date.now(),
        content: "pong",
        sequence: 1,
      }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
