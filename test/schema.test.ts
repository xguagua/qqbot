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

  it("parses full group messages only when the bot is explicitly mentioned", () => {
    const base = {
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "message-id",
        group_openid: "group-id",
        author: {
          member_openid: "owner-id",
          member_role: "owner",
        },
        content: "<@bot-id> /at <@target-id> 你好",
        timestamp: "2026-11-07T00:00:00+08:00",
        message_type: 0,
        mentions: [
          {
            id: "bot-id",
            member_openid: "bot-id",
            bot: true,
            is_you: true,
          },
          {
            id: "target-id",
            member_openid: "target-member-openid",
            bot: false,
            is_you: false,
          },
        ],
      },
    };

    expect(parseWebhookPayload(base)).toMatchObject({
      kind: "event",
      eventType: "GROUP_MESSAGE_CREATE",
      mentions: [
        { id: "bot-id", bot: true, isYou: true },
        {
          id: "target-id",
          memberOpenid: "target-member-openid",
          bot: false,
          isYou: false,
        },
      ],
    });

    const withoutBotMention = {
      ...base,
      d: {
        ...base.d,
        mentions: base.d.mentions.slice(1),
      },
    };
    expect(parseWebhookPayload(withoutBotMention)).toBeNull();
  });
});
