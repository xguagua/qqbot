# QQBot `/version` + `/at` 精简分支

分支：`feature/version-at-only`

该分支只实现两个群内命令：

- `/version`：返回 Worker 部署变量中的 Git commit 和部署时间。
- `/at`：群主通过 `@Bot /at @目标成员 [消息]` 要求机器人主动 @ 唯一目标成员。

`ping`、`/DS`、普通文本聊天、附件聊天、`/chat`、`/autores` 和概率自动回复均不在此分支中。

## 架构

```text
QQ Webhook
  -> Ed25519 原始 Body 验签
  -> GROUP_AT_MESSAGE_CREATE
     或机器人被明确 @ 的 GROUP_MESSAGE_CREATE
  -> 按群 Durable Object 事件去重
  -> /at 或 /version
  -> QQ 群被动回复
```

未明确 @ 机器人的群消息、普通文本和其他斜杠命令不会产生回复。

## `/at`

只有群主可以使用。目标必须来自同一条消息中唯一的真实成员 mention：

```text
@Bot /at @目标成员 晚上好
```

机器人发送 `msg_type=2` Markdown 消息，在 `markdown.content` 中使用：

```html
<qqbot-at-user id="TARGET_MEMBER_OPENID" />
```

普通群消息中，目标必须与完整 `mentions` 列表中的唯一非机器人、非 `is_you` 成员交叉校验。管理员、白名单成员和普通成员均会被拒绝。

为了接收完整 mention，需要在手机 QQ 群机器人设置中将“机器人可获取的群聊消息范围”设为“获取群内全部消息”，并在 QQ 开放平台事件订阅中启用 `GROUP_MESSAGE_CREATE`。两个群消息事件共用 `GROUP_AND_C2C_EVENT (1<<25)`。

## `/version`

部署变量：

```text
GIT_COMMIT_SHA
DEPLOYED_AT
```

`./deploy.sh` 使用 UTC+8 时间覆盖 `DEPLOYED_AT`。

## Secrets

```text
QQ_APP_ID
QQ_CLIENT_SECRET
```

不需要 DeepSeek Key 或 D1 配置。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

真实 `/at` 验收应在指定测试群进行，不要自动向生产群发送测试消息。
