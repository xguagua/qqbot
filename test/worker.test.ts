import { describe, expect, it } from "vitest";
import { handleWebhook } from "../src/worker";
import {
  challengeRequest,
  createHarness,
  event,
  signedEventRequest,
  testEnv,
} from "./helpers";

async function submit(
  request: Request,
  harness = createHarness(),
): Promise<ReturnType<typeof createHarness>> {
  await handleWebhook(request, testEnv(), harness.ctx, harness.factory);
  await harness.flush();
  return harness;
}

describe("minimal version/at worker", () => {
  it("answers health and challenge requests", async () => {
    const harness = createHarness();
    const health = await handleWebhook(
      new Request("https://worker.example/"),
      testEnv(),
      harness.ctx,
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const challenge = await handleWebhook(
      challengeRequest(),
      testEnv(),
      harness.ctx,
    );
    expect(challenge.status).toBe(200);
    await expect(challenge.json()).resolves.toMatchObject({
      plain_token: "Arq0D5A61EgUu4OxUvOp",
      signature: expect.stringMatching(/^[0-9a-f]{128}$/),
    });
  });

  it("returns version metadata", async () => {
    const harness = await submit(
      await signedEventRequest(
        event({ messageId: "version", content: "/version" }),
      ),
    );
    expect(harness.sender.messages[0]?.content).toBe(
      "当前版本\nGit commit: test-commit\n部署时间: 2026-11-08T00:00:00+08:00",
    );
  });

  it("allows only the owner to request a unique real mention", async () => {
    const harness = createHarness();
    await submit(
      await signedEventRequest(
        event({
          messageId: "at-owner",
          memberRole: "owner",
          content: "/at <@!target-id> 晚上好",
          mentions: [
            {
              id: "target-id",
              memberOpenid: "target-member-openid",
              role: "member",
              bot: false,
            },
          ],
        }),
      ),
      harness,
    );
    await submit(
      await signedEventRequest(
        event({
          messageId: "at-admin",
          memberRole: "admin",
          content: "/at <@!target-id> 不允许",
          mentions: [
            {
              id: "target-id",
              memberOpenid: "target-member-openid",
              role: "member",
              bot: false,
            },
          ],
        }),
      ),
      harness,
    );

    expect(harness.sender.messages[0]).toMatchObject({
      content: '<qqbot-at-user id="target-member-openid" /> 晚上好',
      format: "mention",
    });
    expect(harness.sender.messages[1]?.content).toContain("只有群主");
  });

  it("uses full group messages only when the bot is addressed", async () => {
    const harness = createHarness();
    await submit(
      await signedEventRequest(
        event({
          eventType: "GROUP_MESSAGE_CREATE",
          addressedToBot: true,
          messageId: "full-at",
          memberRole: "owner",
          content: "<@bot-id> /at <@target-id> 完整消息",
          mentions: [
            {
              id: "bot-id",
              memberOpenid: "bot-id",
              role: "admin",
              bot: true,
              isYou: true,
            },
            {
              id: "target-id",
              memberOpenid: "target-member-openid",
              role: "member",
              bot: false,
              isYou: false,
            },
          ],
        }),
      ),
      harness,
    );
    await submit(
      await signedEventRequest(
        event({
          eventType: "GROUP_MESSAGE_CREATE",
          addressedToBot: false,
          messageId: "full-unaddressed",
          memberRole: "owner",
          content: "/at <@target-id> 未点名机器人",
          mentions: [
            {
              id: "target-id",
              memberOpenid: "target-member-openid",
              role: "member",
              bot: false,
              isYou: false,
            },
          ],
        }),
      ),
      harness,
    );

    expect(harness.sender.messages).toHaveLength(1);
    expect(harness.sender.messages[0]?.content).toBe(
      '<qqbot-at-user id="target-member-openid" /> 完整消息',
    );
  });

  it("ignores unsupported commands and duplicate events", async () => {
    const harness = createHarness();
    const value = event({ messageId: "duplicate", content: "/version" });
    await submit(await signedEventRequest(value), harness);
    await submit(await signedEventRequest(value), harness);
    await submit(
      await signedEventRequest(
        event({ messageId: "unsupported", content: "/ping" }),
      ),
      harness,
    );

    expect(harness.sender.messages).toHaveLength(2);
    expect(harness.sender.messages[1]?.content).toBe(
      "未知命令，可用命令：/at、/version",
    );
    expect(
      harness.logger.entries.some(
        (entry) => entry.fields.outcome === "duplicate_event",
      ),
    ).toBe(true);
  });
});
