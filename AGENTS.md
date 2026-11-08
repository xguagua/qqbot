# AGENTS.md

本分支为 `feature/version-at-only`。开始工作前先阅读本文件和 `DECISION.md`。

若用户无特别说明，默认提交、推送并使用根目录 `./deploy.sh` 部署。

## 范围

仅实现：

- `/version`
- `/at`

不得恢复 `ping`、DeepSeek、普通聊天、附件、D1 群配置、`/chat`、`/autores` 或概率自动回复。

## Webhook

- 保留原始 Body Ed25519 验签。
- 支持 `op=13` 挑战。
- 接受 `GROUP_AT_MESSAGE_CREATE`。
- 接受机器人被明确 @ 的 `GROUP_MESSAGE_CREATE`。
- 未明确 @ 机器人的完整群消息忽略。
- 跳过机器人作者和不支持的消息类型。
- 使用按群 Durable Object 按消息 `d.id` 去重。
- 验签失败不执行业务逻辑。

## `/version`

- 所有群成员可用。
- 只返回 `GIT_COMMIT_SHA` 和 `DEPLOYED_AT`。
- 不泄露 Secret 或其他环境变量。

## `/at`

- 语法：`@Bot /at @成员 [消息]`。
- 仅 `member_role=owner` 可用。
- 必须直接 @ 唯一目标成员。
- 完整群消息中，目标必须存在于平台 `mentions` 列表。
- 排除机器人自身和其他机器人。
- 目标发送值使用 `member_openid`。
- 输出使用 `msg_type=2` + `markdown.content`：

```html
<qqbot-at-user id="TARGET_MEMBER_OPENID" /> 可选消息
```

- 用户消息部分必须移除伪造的 `qqbot-*` 和 `<@...>` 标签。
- 只发送一条被动回复。

## 权限

- `/version`：所有群成员。
- `/at`：仅群主。
- 昵称不能用于权限判断。

## 发送

- 携带事件 `d.id` 作为 `msg_id`。
- 首页及错误回复使用 `msg_seq=1`。
- 处理 5 分钟窗口和 QQ 业务错误。
- 不在群回复中泄漏 Token 或上游响应。

## 配置

必需 Secrets：

```text
QQ_APP_ID
QQ_CLIENT_SECRET
```

部署变量：

```text
GIT_COMMIT_SHA
DEPLOYED_AT
```

`DEPLOYED_AT` 使用 UTC+8 并带 `+08:00`。

## 测试

必须覆盖：

1. Webhook 挑战。
2. 合法签名、非法签名和时间戳。
3. `/version` 输出。
4. `/at` 仅群主。
5. 唯一目标、`member_openid` 映射和伪造标签拒绝。
6. `GROUP_MESSAGE_CREATE` 仅在机器人被明确 @ 时处理。
7. 重复事件只回复一次。
8. QQ 发送超时和业务错误映射。

## 部署

部署前运行：

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

用户明确要求生产部署时运行 `./deploy.sh`。
