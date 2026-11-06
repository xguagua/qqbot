import type { GroupAtMessageEvent } from "../qq/schema";

export function handleAtRequest(
  event: GroupAtMessageEvent,
  requestedMessage: string,
  mentionIds: readonly string[] = [],
): string {
  if (event.memberRole !== "owner") {
    return "不可以：只有群主可以要求机器人主动 at 成员。";
  }

  const availableTargets = event.mentions.filter((mention) => !mention.bot);
  if (mentionIds.length > 1) {
    return "请在 /at 后只直接 @ 一位目标成员。";
  }

  const requestedTargetId =
    mentionIds[0] ?? (availableTargets.length === 1 ? availableTargets[0]!.id : undefined);
  const targets = availableTargets.filter((mention) => mention.id === requestedTargetId);
  if (requestedTargetId === undefined || targets.length !== 1) {
    return "请在 /at 后直接 @ 一位真实群成员。";
  }

  const target = targets[0]!;
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(target.id)) {
    return "目标成员的标识无效，请重新 @ 后再试。";
  }

  const mention = `<qqbot-at-user id="${target.id}" />`;
  return requestedMessage.length > 0 ? `${mention} ${requestedMessage}` : mention;
}
