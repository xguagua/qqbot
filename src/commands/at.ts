import type { GroupAtMessageEvent } from "../qq/schema";

export function handleAtRequest(
  event: GroupAtMessageEvent,
  requestedMessage: string,
): string {
  if (event.memberRole !== "owner") {
    return "不可以：只有群主可以要求机器人主动 at 成员。";
  }

  const targets = event.mentions.filter((mention) => !mention.bot);
  if (targets.length !== 1) {
    return "请在同一条消息中明确 @ 一位真实群成员。";
  }

  const target = targets[0]!;
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(target.id)) {
    return "目标成员的标识无效，请重新 @ 后再试。";
  }

  const mention = `<qqbot-at-user id="${target.id}" />`;
  return requestedMessage.length > 0 ? `${mention} ${requestedMessage}` : mention;
}
