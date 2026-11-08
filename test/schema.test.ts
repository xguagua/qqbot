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
        content: "<@target-id> 你好",
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

  it("marks full group messages as addressed only when the bot is mentioned", () => {
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
        content: "<@bot-id> 你好",
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
      addressedToBot: true,
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
    expect(parseWebhookPayload(withoutBotMention)).toMatchObject({
      kind: "event",
      eventType: "GROUP_MESSAGE_CREATE",
      addressedToBot: false,
    });
  });

  it("ignores messages authored by a bot", () => {
    expect(
      parseWebhookPayload({
        op: 0,
        t: "GROUP_MESSAGE_CREATE",
        d: {
          id: "bot-message",
          group_openid: "group-id",
          author: {
            member_openid: "bot-id",
            member_role: "admin",
            bot: true,
          },
          content: "机器人消息",
          timestamp: "2026-11-08T00:00:00+08:00",
          message_type: 0,
        },
      }),
    ).toBeNull();
  });

  it("accepts compatible group message aliases and omitted optional fields", () => {
    const payload = parseWebhookPayload({
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "compatible-message",
        group_id: "compatible-group",
        author: {
          id: "compatible-member",
          member_role: "member",
        },
        content: "兼容字段消息",
      },
    });

    expect(payload).toMatchObject({
      kind: "event",
      eventType: "GROUP_MESSAGE_CREATE",
      groupOpenid: "compatible-group",
      memberOpenid: "compatible-member",
      messageType: 0,
      addressedToBot: false,
      timestampMs: expect.any(Number),
    });
  });
});
