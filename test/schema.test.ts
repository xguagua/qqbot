import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "../src/qq/schema";

describe("group event mention parsing", () => {
  it("falls back to member_openid when mentions.id is absent", () => {
    const payload = parseWebhookPayload({
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "message-id",
        group_openid: "group-id",
        author: {
          member_openid: "owner-id",
          member_role: "owner",
        },
        content: "/at <@!target-id> 你好",
        timestamp: "2026-11-07T00:00:00+08:00",
        message_type: 0,
        mentions: [{ member_openid: "target-id", bot: false }],
      },
    });
    expect(payload).toMatchObject({
      kind: "event",
      mentions: [
        {
          id: "target-id",
          memberOpenid: "target-id",
          bot: false,
        },
      ],
    });
  });
});
