import type { GroupAtMessageEvent } from "../qq/schema";
import type { CommandResult } from "./types";

export function handleAtRequest(
  event: GroupAtMessageEvent,
  requestedMessage: string,
  mentionIds: readonly string[] = [],
): CommandResult {
  if (event.memberRole !== "owner") {
    return "不可以：只有群主可以要求机器人主动 at 成员。";
  }

  const botMentionIds = new Set(
    event.mentions
      .filter((mention) => mention.bot || mention.isYou)
      .flatMap((mention) => [
        mention.id,
        ...(mention.memberOpenid === undefined ? [] : [mention.memberOpenid]),
      ]),
  );
  const targetMentionIds = mentionIds.filter((id) => !botMentionIds.has(id));
  const availableTargets = event.mentions.filter(
    (mention) => !mention.bot && !mention.isYou,
  );
  if (targetMentionIds.length > 1) {
    return "请在 /at 后只直接 @ 一位目标成员。";
  }

  const directTarget = targetMentionIds[0];
  const matchedTarget =
    directTarget === undefined
      ? undefined
      : availableTargets.find(
          (mention) =>
            mention.id === directTarget || mention.memberOpenid === directTarget,
        );
  if (
    event.eventType === "GROUP_MESSAGE_CREATE" &&
    directTarget !== undefined &&
    matchedTarget === undefined
  ) {
    return "目标成员不在本消息的 mention 列表中，请重新 @ 后再试。";
  }

  const fallbackTarget =
    availableTargets.length === 1 ? availableTargets[0] : undefined;
  const requestedTargetId =
    matchedTarget?.memberOpenid ??
    matchedTarget?.id ??
    (event.eventType === "GROUP_AT_MESSAGE_CREATE" ? directTarget : undefined) ??
    fallbackTarget?.memberOpenid ??
    fallbackTarget?.id;
  if (requestedTargetId === undefined) {
    return "请在 /at 后直接 @ 一位真实群成员。";
  }
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(requestedTargetId)) {
    return "目标成员的标识无效，请重新 @ 后再试。";
  }

  const mention = `<qqbot-at-user id="${requestedTargetId}" />`;
  return {
    content:
      requestedMessage.length > 0 ? `${mention} ${requestedMessage}` : mention,
    format: "mention",
  };
}
