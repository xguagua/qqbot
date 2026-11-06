# QQBot

Cloudflare Worker 实现的 QQ 官方机器人主分支。它只处理群内 `@机器人` 事件，提供：

- `ping` → `pong`
- `/DS ask <问题>`
- 管理员 `/DS set model <模型>`
- 管理员 `/DS set think <none|low|high|max>`
- 管理员 `/DS set spm <System Prompt>`
- 管理员 `/DS clear <model|think|spm>`
- 管理员 `/DS query <model|think|spm>`
- `/help [Command]` 与 `/DS list [model|think]`
- 管理员 `/chat [true|false]` 查询或调整群聊天开关
- `/version` 返回部署时间与 Git commit
- 群主 `/at @成员 [消息]` 主动 @ 直接指定的成员
- 普通文本：以流萤角色进行按用户隔离的短期聊天
- 普通聊天和 `/DS ask` 支持附带文件

`/pw` 不在主分支中。

## 当前状态

主分支代码、D1 迁移、Worker 本地测试和本地 D1 集成测试已实现。Cloudflare Worker 部署到自定义域名 `https://qqbot.xguagua.cc.cd`，远程 D1 表和索引已确认，三个运行时 Secrets 均已配置，QQ Webhook 已绑定并能收到 `GROUP_AT_MESSAGE_CREATE` 事件。线上日志已确认真实 `ping` 和 `/DS ask` 完成 `reply_sent`。当前主分支包含流萤上下文聊天、聊天/DS 附件、图片与 GIF 表情包、群聊天开关、引用消息、`/version` 和群主 `/at`。

本地 Git 仓库的 `main` 跟踪 `origin/main`；按具体任务要求执行提交与推送。

部署教程可按以下路径阅读：

- [部署前准备](#2-部署前准备)与 [Cloudflare 登录](#3-登录并确认-cloudflare-账号)
- [创建 D1](#4-创建-d1-并写入真实-database_id)与 [应用远程迁移](#5-对远程-d1-应用迁移)
- [首次部署 Worker](#6-首次部署-worker)与 [设置 Secrets](#7-设置生产-secrets)
- [检查线上日志](#10-查看线上日志)、[冒烟验收](#11-测试群冒烟验收)与 [故障排查](#12-常见故障排查)
- [更新版本](#13-更新版本)、[回滚](#14-回滚)与 [Secret 轮换](#15-secret-轮换与泄露处理)

## 架构

```text
QQ Webhook
  -> Worker 原始请求体验签
  -> 按事件 ID 原子去重
  -> 尽快返回 op=12
  -> waitUntil 后台处理
       -> D1 群配置
       -> D1 短期聊天上下文（群 + 用户）
       -> 按群 Durable Object：去重、限流、群预算
       -> 全局 Durable Object：全局预算
       -> DeepSeek Chat Completions
       -> QQ 群被动回复
```

关键约束：

- 验签使用原始 Body，正文为 `timestamp + rawBody`。
- Ed25519 seed 由 `clientSecret` 重复扩展后截取 32 字节。
- `/DS ask` 只发送当前问题和当前群 System Prompt，不发送昵称、OpenID、群 ID 或历史消息。
- 只使用 `reasoning_effort` 表达思考档位，不额外发送重叠的 `thinking` 参数。
- 回复固定携带事件 `d.id` 作为 `msg_id`，单次指令只发送一条消息，`msg_seq` 为 1。
- `/DS ask` 不保存上下文；普通文本聊天仅保存当前群、当前用户最近 8 条消息，24 小时后失效。
- D1 还保存群配置和字段级变更审计；过期聊天上下文与 30 天前审计由每日定时任务清理。
- 普通文本聊天固定使用 `deepseek-flash:off`，API 映射为 `model=deepseek-flash` + `reasoning_effort=none`，并使用不可覆盖的流萤角色 System Prompt。
- 普通聊天不设置频率计数；仍受每群和全局费用预算约束。`/DS ask` 保持原有独立限流。
- 代码编写/修改/调试请求和高置信度提示词注入不调用 DeepSeek；代码样式模型输出会再次拦截。
- 普通聊天和 `/DS ask` 会下载当前消息附件并以 DeepSeek `image_url`/`file` 内容片段发送；附件不写入 D1。
- 普通聊天使用群级 `chat_enabled` 开关；关闭后普通文本与附件聊天不调用 DeepSeek，但 `/DS` 命令不受影响。
- QQ 引用消息 `message_type=103` 会递归提取 `msg_elements` 中全部文本（不只是第一段），作为不可信上下文与当前消息一起发送。
- 引用元素中的嵌套图片和 GIF 表情包附件会被收集并发送给 DeepSeek；QQ 表情标签归一化为 `[表情]`。

## 附件处理

- 每条消息最多 3 个附件，包括顶层和引用 `msg_elements` 中的图片/文件。
- 单文件上限 4 MB，附件总大小上限 8 MB。
- 只接受 HTTPS、标准 443 端口，并拒绝 localhost、私网 IP 和带用户凭据的 URL。
- 图片使用 `image_url` 片段，其他文件使用 `file` 与 base64 `file_data` 片段。
- 附件只在当前 Worker 请求内存中处理，不写入 D1、日志或聊天上下文。
- 附件下载总超时 5 秒；带附件请求会缩短 DeepSeek 响应超时，为 QQ 被动回复留余量。
- 附件内容按不可信输入处理，不能改变角色、系统规则或绕过代码限制。

## 主动 @ 成员

只有群主可以要求机器人主动 @ 一位成员。必须在同一条消息中通过 QQ 的 @ 功能选择唯一目标，再发送：

```text
@Bot /at @目标成员 [要发送的文字]
```

机器人使用官方 `<qqbot-at-user id="..." />` 标记回复。目标优先匹配 `/at` 后的结构化 `<@!ID>` 标记，并兼容 `<qqbot-at-user id="..." />`；事件 `mentions[].id` 或 `member_openid` 用于交叉校验。官方文档这一用法也存在字段差异，因此不使用昵称授权；普通成员和管理员不能执行。

## 版本信息

`/version` 返回 Worker 环境变量中的：

- `GIT_COMMIT_SHA`
- `DEPLOYED_AT`

`wrangler.toml` 仅保存 `unknown` 占位值。部署时应覆盖为实际值：

```bash
pnpm exec wrangler deploy \
  --strict \
  --domain qqbot.xguagua.cc.cd \
  --var "GIT_COMMIT_SHA:$(git rev-parse HEAD)" \
  --var "DEPLOYED_AT:$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## 服务端硬限制

以下值集中在 `src/config.ts`，部分可由 Wrangler 变量调整，但会在服务端钳制到硬上限：

| 项目 | 默认值 | 硬边界 |
| --- | ---: | ---: |
| `/DS ask` 每群每分钟 | 3 次 | 最多 10 次 |
| `/DS ask` 每人冷却 | 30 秒 | 10–300 秒 |
| 附件数量 | 3 个 | 固定 |
| 单附件大小 | 4 MB | 固定 |
| 附件总大小 | 8 MB | 固定 |
| 每群每日预算（UTC） | `$0.10` | 最多 `$1.00` |
| 全局每日预算（UTC） | `$5.00` | 最多 `$25.00` |
| 单次问题长度 | 2,000 字 | 固定 |
| 普通聊天输入 | 1,000 字 | 固定 |
| System Prompt 长度 | 1,000 字 | 固定 |
| DeepSeek 输出上限 | 1,024 tokens | 固定 |
| QQ 回复内容 | 1,500 字 | 固定 |
| DeepSeek 超时 | 18 秒 | 固定 |
| QQ 请求超时 | 7 秒 | 固定 |
| 事件去重 TTL | 10 分钟 | 固定 |
| 聊天上下文 | 最近 8 条，24 小时 | 固定 |

费用按 DeepSeek 官方 2026-10-25 公布的峰值价格做保守整数换算，单位是 nano-USD。请求前按最大输入和输出预留额度；成功响应后按 `usage` 结算，超时等结果不确定的请求保留预留额度，避免低估费用。

## 本地检查

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

本地 D1 迁移和集成测试：

```bash
pnpm db:migrate:local
pnpm test:integration
```

`test:integration` 使用本机 Wrangler/Miniflare 的临时 D1，不连接 Cloudflare，不需要真实 Secret，也不会向 QQ 或 DeepSeek 发请求。

## 部署教程

本节是完整的人工部署流程。命令会连接 Cloudflare 或 QQ 平台，其中创建 D1、Durable Object、Worker、Secrets 和修改 Webhook 都属于外部状态变更。执行前必须取得明确授权；不要在未确认账号、测试群和费用影响时直接运行。

建议第一次部署只使用**测试机器人凭据和测试群**。如果测试与生产共用同一个 QQ AppID，它们也会共用同一条 Webhook，不能在未通知的情况下切换生产流量。

### 1. 部署拓扑

一次正常部署涉及以下 Cloudflare 资源：

| 资源 | 名称/绑定 | 用途 | 创建方式 |
| --- | --- | --- | --- |
| Worker | `qqbot` | Webhook 入口、命令处理和定时任务 | `wrangler deploy` |
| D1 | `qqbot`，绑定 `DB` | 群配置和 30 天配置审计 | `wrangler d1 create` |
| Durable Object | `GroupGuard`，绑定 `GROUP_GUARD` | 按群去重、限流和群预算 | 首次部署时创建 |
| Durable Object | `GlobalBudget`，绑定 `GLOBAL_BUDGET` | 全局每日预算 | 首次部署时创建 |
| Cron Trigger | `0 3 * * *` | 清理过期审计 | 随 Worker 部署 |

Durable Object 没有单独的 `wrangler create` 命令。`wrangler.toml` 中的绑定和 `[[migrations]]` 会在首次部署时声明并创建它。不要手工删除或重命名 `GroupGuard`、`GlobalBudget`、`GROUP_GUARD`、`GLOBAL_BUDGET`，否则可能造成绑定错误或状态无法关联。

### 2. 部署前准备

需要准备：

1. 一个有权限创建 Workers、D1 和 Durable Object 的 Cloudflare 账号。
2. 与测试环境一致的 QQ 机器人 `AppID` 和 `ClientSecret`。
3. 一个可用的 DeepSeek API Key 和足够测试的余额。
4. 一个只用于验收的 QQ 测试群。
5. 已安装的 Node.js、pnpm 和项目依赖。

当前 Wrangler 要求使用其支持的 Node.js 当前版、Active LTS 或维护版。若账号创建 Durable Object 或提高免费额度会触发付费、订阅或套餐变更，应先停止并向账号所有者确认。

在项目根目录执行基础检查：

```bash
cd /home/xguagua/Projects/QQBot
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

`pnpm build` 只做 Wrangler dry-run，不会部署。`pnpm test:integration` 使用本机临时 D1，不需要真实 Secret。以上检查必须全部通过后再操作云端。

如需先在本地观察 Worker 请求，可创建未跟踪的 `.dev.vars`：

```bash
cp .dev.vars.example .dev.vars
pnpm dev
```

`.dev.vars` 只能放本地占位或测试值，`.gitignore` 已排除该文件。不要把真实 Secret 写入代码、`wrangler.toml`、README、测试夹具或聊天消息。

### 3. 登录并确认 Cloudflare 账号

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
```

`wrangler login` 会打开浏览器进行 OAuth 授权。`whoami` 必须显示准备使用的账号和账号 ID。如果终端有多个 Cloudflare 账号，先确认当前登录账号再继续；不要把资源创建到错误账号。

后续命令都以项目根目录为工作目录。这样 Wrangler 会读取本项目固定的 `wrangler.toml` 和锁定的 Wrangler 版本。

如需在浏览器中核对资源，登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) 后使用同一个账号。不要把 Dashboard 中显示的 Secret 值复制到公开位置。

### 4. 创建 D1 并写入真实 database_id

先检查账号里是否已经存在名为 `qqbot` 的数据库：

```bash
pnpm exec wrangler d1 list
```

如果没有，再创建：

```bash
pnpm exec wrangler d1 create qqbot
```

命令成功后，输出中会有类似下面的绑定信息和 `database_id`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "qqbot"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
migrations_dir = "migrations"
```

只把 `wrangler.toml` 中当前的占位值：

```toml
database_id = "REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID"
```

替换为本次实际返回的 `database_id`。不要改动 `binding = "DB"`、`database_name = "qqbot"` 或 `migrations_dir`。

占位符未替换时不要执行远程部署；dry-run 可以用于检查代码，但不能证明远程 D1 绑定有效。

确认配置指向正确数据库：

```bash
pnpm exec wrangler d1 info qqbot
```

如果 `qqbot` 已存在，不要重复创建第二个同名或近似数据库；应在 `d1 list` 中找到原数据库并复用其 ID。

### 5. 对远程 D1 应用迁移

先把迁移应用到远程数据库，再上线依赖 D1 的指令：

```bash
pnpm exec wrangler d1 migrations list qqbot --remote
pnpm exec wrangler d1 migrations apply qqbot --remote
```

执行前 Wrangler 会显示待应用迁移，正常情况下应看到：

```text
0001_initial.sql
0002_chat_sessions.sql
0003_chat_enabled.sql
```

该迁移创建：

- `group_configs`：每群模型、思考强度、System Prompt、聊天开关、更新人和版本。
- `config_audits`：仅记录变更字段和版本，不复制完整 System Prompt。
- `chat_sessions`：按群和用户保存 24 小时短期聊天上下文，只保留最近 8 条消息。
- 审计与聊天过期时间查询索引。

不要用 `wrangler d1 execute` 代替正式迁移，也不要对远程数据库执行来源不明的 SQL。Worker 部署成功但 `/DS` 返回“服务繁忙”时，应先检查这里是否漏了 `--remote`。

### 6. 首次部署 Worker

确认以下三项后再部署：

- `wrangler.toml` 中的 `database_id` 已替换。
- 远程 D1 迁移已成功。
- `pnpm typecheck`、`pnpm test`、`pnpm build` 均通过。

执行：

```bash
pnpm exec wrangler deploy --message "initial qqbot test deployment"
```

如果希望 Wrangler 在发现远程配置已被其他人修改时拒绝覆盖，可改用：

```bash
pnpm exec wrangler deploy --strict --message "initial qqbot test deployment"
```

首次部署会同时：

- 上传 Worker `qqbot`。
- 根据绑定创建 `GROUP_GUARD` 和 `GLOBAL_BUDGET`。
- 应用 Durable Object 迁移标签 `v1`，以 SQLite 存储类创建两个 Durable Object。
- 配置每日 `03:00 UTC` 的审计清理任务。

部署成功后，记录终端输出的：

- Worker 版本 ID。
- `https://qqbot.<你的账号子域>.workers.dev` 地址。
- 部署时间。

如果没有 `workers.dev` 地址，先在 Cloudflare Dashboard 的 Workers 设置中确认 workers.dev 子域，或之后绑定自定义 HTTPS 域名。QQ 回调必须是 HTTPS；`workers.dev` 默认使用 443 端口。

此时还不要配置 QQ Webhook。首次部署后 Worker 还没有生产 Secrets，先完成下一步。

### 7. 设置生产 Secrets

三个必需值都通过交互式命令写入 Cloudflare Secrets：

```bash
pnpm exec wrangler secret put QQ_APP_ID
pnpm exec wrangler secret put QQ_CLIENT_SECRET
pnpm exec wrangler secret put DEEPSEEK_API_KEY
```

每次命令会提示输入值。直接在隐藏提示中粘贴，不要把 Secret 作为命令行参数、不要写进 shell 历史、README、Issue、群消息或截图。`QQ_APP_ID` 本身通常不是敏感凭据，但存入 Secret 可以避免环境专属 ID 被误提交到仓库。

确认 Secret 名称存在：

```bash
pnpm exec wrangler secret list
```

该命令只应显示 Secret 名称和类型，不应显示值。必须确认：

```text
QQ_APP_ID
QQ_CLIENT_SECRET
DEEPSEEK_API_KEY
```

如果 `secret put` 提示 Worker 不存在，回到第 6 步完成首次部署，再重新设置 Secrets。设置或更新 Secret 后，先在 Cloudflare 侧确认新版本可处理请求，再继续配置 QQ。

### 8. 配置非敏感参数

默认参数已经写在 `wrangler.toml` 的 `[vars]` 中：

```toml
[vars]
ADMIN_WHITELIST = "{}"
DS_GROUP_LIMIT_PER_MINUTE = "3"
DS_MEMBER_COOLDOWN_SECONDS = "30"
DS_GROUP_DAILY_BUDGET_NANO_USD = "100000000"
DS_GLOBAL_DAILY_BUDGET_NANO_USD = "5000000000"
```

预算单位是 nano-USD：

- `100000000` = `$0.10`
- `1000000000` = `$1.00`
- `5000000000` = `$5.00`
- `25000000000` = `$25.00`

代码会在服务端把可调参数限制在 README 前文“服务端硬限制”列出的硬边界内。修改这些值后需要重新执行：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm exec wrangler deploy --message "update qqbot runtime limits"
```

推荐首次测试保持默认值，尤其不要把每日预算直接提高到硬上限。

`ADMIN_WHITELIST` 是可选的群级管理员补充授权。群主和管理员已经能修改配置，通常不需要白名单。若确有普通成员管理需求，格式为：

```json
{
  "group-openid-a": ["member-openid-1"],
  "group-openid-b": ["member-openid-2"]
}
```

键和成员必须来自同一群的验签事件，不能跨群复用。OpenID 不应无必要地提交到仓库；若需要配置真实白名单，建议先移除 `[vars]` 中的 `ADMIN_WHITELIST = "{}"` 并部署一次，再用交互式 Secret 写入：

```bash
pnpm build
pnpm exec wrangler deploy --message "remove admin whitelist plain variable"
pnpm exec wrangler secret put ADMIN_WHITELIST
```

在 Secret 写入前，白名单为空，但群主和管理员权限不受影响。不要把昵称当作白名单键，也不要在日志、群回复或截图中公开 OpenID。

### 9. 在 QQ 开放平台配置 Webhook

确认 Secrets 已存在后再操作 QQ 开放平台：

1. 登录 [QQ 机器人开放平台](https://bot.q.qq.com/open)，选择与 `QQ_APP_ID` 完全一致的机器人。
2. 进入该机器人的开发设置或回调配置页面。平台菜单名称可能调整，以页面当前文案为准。
3. 回调地址填写 Worker 的 HTTPS 根地址，例如：

   ```text
   https://qqbot.<你的账号子域>.workers.dev/
   ```

4. 端口使用 HTTPS 默认的 `443`；不要填写本地 `http://`、局域网地址或非允许端口。
5. 事件订阅至少选择群内 `@机器人` 消息，对应 `GROUP_AT_MESSAGE_CREATE`。
6. 不要额外订阅全量群消息。主分支只处理 `GROUP_AT_MESSAGE_CREATE`，全量消息既不需要也会扩大隐私范围。
7. 保存配置。QQ 会立即发送 `op=13` 挑战请求；Worker 会使用 `QQ_CLIENT_SECRET` 派生的 Ed25519 密钥签名，并返回 `plain_token` 和十六进制 `signature`。
8. 保存成功后，把机器人邀请到指定的测试群。

回调地址应使用根路径 `/`，不要附带查询参数。Cloudflare 会自动提供有效 HTTPS 证书，不需要上传证书或购买 VPS。

当 QQ 平台保存成功，再进入冒烟测试；平台保存失败代表链路尚未验收，不能继续测试 `/DS`。

### 10. 查看线上日志

冒烟测试时另开一个终端：

```bash
pnpm exec wrangler tail qqbot --format pretty
```

保持该命令运行，测试结束后按 `Ctrl+C` 退出。

日志只包含规范化结果，例如：

- `reply_sent`
- `duplicate_event`
- `ignored_command`
- `event_failed`
- `settlement_failed`
- `reply_window_expired`

日志不会输出聊天正文、模型回答、完整 System Prompt、附件 URL、附件字节、Access Token 或 Secret。不要为了排障临时加入打印完整 `env`、请求头、请求 Body 或模型响应的日志。

### 11. 测试群冒烟验收

以下步骤必须由有测试群操作权限的人在测试群执行。不要向生产群发送自动测试消息。

#### 11.1 验证回调与 `ping`

在测试群发送：

```text
@机器人 ping
```

预期公开回复：

```text
pong
```

同时 `wrangler tail` 应出现 `reply_sent`。QQ 平台或 Worker 返回 HTTP 200 只代表回调被接收，不等于 QQ 群消息发送成功；必须以群里真实收到 `pong` 为准。

#### 11.2 验证管理员配置

由测试群群主、管理员或已配置白名单成员依次发送：

```text
@机器人 /DS set model deepseek-flash
@机器人 /DS set think low
@机器人 /DS set spm 你是一个简洁、准确的群聊助手。
```

预期每次只有当前群配置变化，并收到公开成功提示。普通成员执行同一命令时必须收到“权限不足”。

查询当前配置：

```text
@机器人 /DS query model
@机器人 /DS query think
@机器人 /DS query spm
```

`query spm` 会把当前 System Prompt 公开发到群里，因此只应由授权管理员执行。

分别恢复默认值：

```text
@机器人 /DS clear model
@机器人 /DS clear think
@机器人 /DS clear spm
```

每次 `clear` 只重置指定字段，其他群配置保持不变。默认值为 `deepseek-flash`、`low` 和仓库内置安全 Prompt。

帮助与能力列表：

```text
@机器人 /help
@机器人 /help /DS query
@机器人 /help /chat
@机器人 /DS list model
@机器人 /DS list think
```

输入不存在的斜杠命令或错误命令结构时，应返回：

```text
未知命令，请输入 /help 查询
```

由管理员验证群聊天开关：

```text
@机器人 /chat
@机器人 /chat false
@机器人 这条普通聊天应被关闭提示拒绝
@机器人 /DS ask /chat 关闭后 DS 仍应可用
@机器人 /chat true
```

`/chat` 无参数查询状态；`true`/`false` 只影响当前群的普通聊天。

#### 11.3 验证 `/DS ask`

```text
@机器人 /DS ask 用一句话解释什么是 Cloudflare Worker
```

预期在 QQ 被动回复窗口内返回 DeepSeek 的最终回答。首版无上下文，同一个群连续两次提问互相独立。

检查：

- 回答公开发到群里。
- 超时或失败时只显示“AI 服务繁忙”等可操作提示。
- 日志不出现问题正文或回答正文。
- 默认模型为 `deepseek-flash`，默认思考强度为 `low`。
- 达到每群、每人或预算限制后，不再调用 DeepSeek，并公开提示限额。

#### 11.4 验证流萤聊天、上下文与安全边界

直接发送不带 `/` 的普通文本：

```text
@机器人 晚上好，流萤。
```

预期以温和、克制、简洁的流萤口吻公开回复。验证：

- 聊天固定使用 `deepseek-flash` 非思考模式，不受 `/DS set model|think` 影响。
- 同一群同一用户随后再聊一句，可以延续最近上下文。
- 另一个用户或另一个群不会继承该上下文。
- 普通聊天没有次数冷却；达到群/全局费用上限后才拒绝。
- `/DS ask` 仍独立执行每群每分钟 3 次和每人 30 秒冷却。
- 聊天上下文只在 D1 保存 24 小时，最多 8 条消息。
- 请求编写、修改或调试代码时直接拒绝，且不调用 DeepSeek。
- 要求忽略系统指令、改变角色或披露 Prompt 时直接拒绝。
- 即使模型试图输出代码块，Worker 也会二次拦截。
- 聊天附带图片或文件时会一并发送给 DeepSeek，且附件不会写入聊天上下文。
- 引用一条群消息后发送聊天文本，Worker 应正常处理当前正文，并保留引用与后续 `msg_elements` 文本。
- 仅引用消息、不输入新正文时，也应能进入普通聊天。

再测试 `/DS ask` 附件：

```text
@机器人 /DS ask 请描述这个附件
```

发送时附上 1 个不超过限制的图片或文件，预期 DeepSeek 能结合附件回答。

#### 11.5 验证去重和被动回复

平台的相同事件可能重复投递。正常情况下，相同 `d.id` 只会对应一次 DeepSeek 请求和一次业务回复；重复投递应记录为 `duplicate_event`，不会再次消耗模型额度。

不要在群里要求机器人对同一提示连续多次回复来测试重试。代码设计为每次指令尽量只回复一次，以减少 `msg_id + msg_seq` 重复和 5 分钟窗口超限。

#### 11.6 记录验收结果

每次真实测试至少记录：

| 项目 | 内容 |
| --- | --- |
| 时间 | 精确到分钟 |
| 环境 | Worker 版本 ID、Worker URL |
| 测试群 | 仅记录内部测试群标识，不要公开 |
| 输入 | 不含 Secret 的指令 |
| 预期 | 例如公开回复 `pong` |
| 实际 | 群内是否收到、返回内容概要 |
| 日志 | 规范化结果码，不要保存完整日志或聊天正文 |

所有主分支验收标准通过前，不要把该版本称为“线上可用”。

### 12. 常见故障排查

#### QQ 保存回调时失败

按以下顺序检查：

1. `wrangler.toml` 的 Worker 名和部署目标账号是否正确，QQ 平台 AppID 是否与 Cloudflare Secret 一致。
2. `QQ_CLIENT_SECRET` 必须填写 QQ 开放平台中的**机器人 AppSecret**，不是旧 Token、Access Token，也不是另一个机器人的密钥。
3. 确认最近没有在 QQ 平台重置或重新生成 AppSecret；重置后必须同步更新 Cloudflare。
4. `QQ_APP_ID` 和 AppSecret 必须属于同一个机器人。
5. 通过 `wrangler secret put` 输入时不要自行添加引号；CLI 会按原样保存输入值。
6. 回调是否为 `https://.../` 根地址，端口是否为允许的 HTTPS 端口。
7. `wrangler tail` 是否显示 `appid_mismatch`、`configuration` 或其他错误码。
8. 本地 `pnpm test` 中的官方挑战签名向量是否通过。

QQ 官方 Webhook 页公开了一组可用于校验实现的测试向量：

```text
AppSecret: DG5g3B4j9X2KOErG
event_ts:  1725442341
plain_token: Arq0D5A61EgUu4OxUvOp
signature: 87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706
```

仓库测试已经使用该向量。若本地测试通过、线上 `op=13` 也返回 HTTP 200，但 QQ 平台仍提示签名校验失败，说明签名实现正确，应重点检查 Cloudflare 中保存的 AppID/AppSecret 是否是当前机器人的正确配对值。

可以重新交互式写入两个凭据：

```bash
pnpm exec wrangler secret put QQ_APP_ID
pnpm exec wrangler secret put QQ_CLIENT_SECRET
pnpm exec wrangler secret list
```

随后在 QQ 平台重新保存回调。不要通过聊天发送 AppSecret，也不要把它写入 README、`.dev.vars.example` 或 `wrangler.toml`。

#### `ping` 没有回复

1. 确认机器人已进入测试群，且消息确实 `@` 了机器人。
2. 确认订阅的是群内 `@机器人` 消息，而不是仅全量群消息。
3. 用 `wrangler tail` 检查是否收到请求。没有日志通常是 QQ 回调配置问题。
4. 有 `duplicate_event` 表示该事件已被处理过，这是去重行为。
5. 有 `qq_business_error` 时检查机器人是否被移出群、禁言、下线，或消息是否超过被动回复窗口。

#### `/DS ask` 返回“服务繁忙”或“尚未配置”

1. 检查 `DEEPSEEK_API_KEY` Secret 是否存在、是否有效。
2. 检查 DeepSeek 账户余额、限流和服务状态。
3. 检查是否触发每群、每人或预算限制。
4. 检查 Worker 日志中的规范化错误码；不要把上游响应原文贴到群或 Issue。

#### `/DS` 返回“服务繁忙”但 `ping` 正常

这通常说明 QQ Webhook 和消息发送链路正常，但 D1 配置读取或 DeepSeek 调用失败：

```bash
pnpm exec wrangler d1 migrations list qqbot --remote
pnpm exec wrangler secret list
pnpm exec wrangler tail qqbot --format pretty
```

重点检查远程迁移是否已应用、`DB` 绑定是否指向正确数据库，以及 D1 是否被删除或改名。

#### 首次部署 Durable Object 失败

先阅读 Wrangler 的完整错误信息，常见原因包括：

- 当前账号或套餐不允许创建对应 Durable Object。
- 账单、付款方式或资源配额需要确认。
- `wrangler.toml` 中的绑定类名与导出类名不一致。
- 已有迁移标签冲突。

不要在未确认费用的情况下升级套餐，也不要反复删除资源重试。先保存错误信息，确认账号权限和费用后再继续。

#### 远程 D1 查询不到表

`wrangler d1 migrations apply qqbot --local` 只创建本机数据库。远程部署必须再执行：

```bash
pnpm exec wrangler d1 migrations list qqbot --remote
pnpm exec wrangler d1 migrations apply qqbot --remote
```

### 13. 更新版本

每次发布按以下顺序：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm exec wrangler d1 migrations list qqbot --remote
pnpm exec wrangler deploy --message "describe this change"
```

如果 `d1 migrations list` 显示未应用迁移，应先审查 SQL，再执行：

```bash
pnpm exec wrangler d1 migrations apply qqbot --remote
```

部署后检查：

```bash
pnpm exec wrangler deployments status
pnpm exec wrangler tail qqbot --format pretty
```

然后重新执行测试群 `ping` 和最小 `/DS ask` 冒烟测试。不要只凭部署命令成功或 Worker HTTP 200 宣告发布成功。

### 14. 回滚

查看最近部署和版本 ID：

```bash
pnpm exec wrangler deployments list
```

回滚到上一个已验证版本：

```bash
pnpm exec wrangler rollback <version-id> --message "rollback after failed smoke test"
```

Wrangler 会要求确认。回滚后重新执行 `ping`，并检查：

```bash
pnpm exec wrangler deployments status
pnpm exec wrangler tail qqbot --format pretty
```

重要限制：

- Worker 回滚不会自动撤销已经应用到 D1 的迁移，也不会回滚 Durable Object 的内部状态。
- 涉及破坏性表结构变更时，不能把 Worker 回滚当作完整数据库回滚。
- Durable Object 类重命名或删除属于资源迁移，不能只靠普通 Worker 版本回滚恢复。
- 当前主分支没有执行任何远程迁移或部署，首次上线前应保留实际版本 ID 和部署记录。

### 15. Secret 轮换与泄露处理

轮换 DeepSeek Key：

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY
```

然后立即在 DeepSeek 控制台撤销旧 Key，并重新测试 `/DS ask`。

轮换 QQ ClientSecret 时，要同时更新 QQ 开放平台和 Cloudflare，两者不一致会导致验签、挑战响应或 Access Token 获取失败：

```bash
pnpm exec wrangler secret put QQ_CLIENT_SECRET
```

若 Secret 曾进入日志、聊天、截图或提交记录，应视为已泄露：

1. 立即在对应平台撤销或轮换凭据。
2. 更新 Cloudflare Secret。
3. 检查 Worker 版本和部署记录。
4. 停止相关外部调用，直到测试群验证恢复。

不要只在代码里删除字符串就认为轮换完成；旧凭据在平台侧仍然有效。

### 16. 测试/生产隔离

当前 `wrangler.toml` 只定义一个 Worker `qqbot`，没有 `[env.staging]` 或 `[env.production]`。首次上线建议直接用测试机器人凭据和一个测试群完成验收。

如果要建立严格的双环境：

- 测试和生产必须使用不同的 Worker 名。
- 测试和生产必须使用不同的 D1 数据库和 `database_id`。
- Durable Object 迁移、Secrets、每日预算和 Webhook 都必须分别配置。
- 不能共享生产 D1 做测试，也不能让测试群写入生产群配置。
- 为不同环境建立独立 Wrangler 配置或在 `wrangler.toml` 中新增明确的 `env` 段后，再单独验证部署命令。

不要只运行 `wrangler deploy --env production` 就假设环境隔离已经存在；必须先在配置文件中确认对应环境、资源和绑定都已声明。

### 17. 上线前检查清单

- [ ] Cloudflare 登录账号和 QQ AppID 属于同一个预期项目。
- [ ] `wrangler.toml` 的 D1 `database_id` 已替换，不是占位符。
- [ ] 远程 D1 迁移 `0001_initial.sql` 已应用。
- [ ] 远程 D1 迁移 `0002_chat_sessions.sql` 已应用。
- [ ] 远程 D1 迁移 `0003_chat_enabled.sql` 已应用。
- [ ] `QQ_APP_ID`、`QQ_CLIENT_SECRET`、`DEEPSEEK_API_KEY` 已设置为 Secrets。
- [ ] `wrangler secret list` 不显示任何 Secret 值。
- [ ] Durable Object 两个类已随 Worker 首次部署成功创建。
- [ ] Worker 使用 HTTPS，QQ 回调为根地址。
- [ ] QQ 只订阅 `GROUP_AT_MESSAGE_CREATE`，没有订阅全量群消息。
- [ ] 测试群先通过 `ping`，之后才测试 `/DS`。
- [ ] 普通成员无法修改配置，群主/管理员可以修改当前群配置。
- [ ] 每群限流、每人冷却、群预算和全局预算均实际验证。
- [ ] `wrangler tail` 中不出现聊天正文、模型回答、System Prompt 或 Secret。
- [ ] Worker 版本 ID、部署时间、回滚版本和测试记录已保存。
- [ ] 用户明确确认测试结果后，才切换生产群或生产 Webhook。

### 18. 官方参考资料

- [QQ Webhook 配置与验签](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)
- [QQ 回调签名算法](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html)
- [QQ 群 @ 机器人事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [Cloudflare Workers 部署](https://developers.cloudflare.com/workers/wrangler/commands/#deploy)
- [Cloudflare Wrangler Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 入门](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Durable Objects 入门](https://developers.cloudflare.com/durable-objects/get-started/)
- [DeepSeek API Key](https://platform.deepseek.com/api_keys)
- [《崩坏：星穹铁道》官方网站](https://sr.mihoyo.com/)
- [HoYoWiki](https://wiki.hoyolab.com/)
- [Firefly 角色资料（Wikipedia）](https://en.wikipedia.org/wiki/Firefly_(Honkai:_Star_Rail))

## 已知运行边界

- Worker 在完成验签和原子去重声明后，通过 `waitUntil` 执行后续处理。处理链设定了 18 秒 DeepSeek 和 7 秒 QQ 超时，以适配 Workers 的响应后执行时限。
- `waitUntil` 不是持久队列。如果真实测试发现任务会被中断，应先记录证据，再获得用户同意后引入 Queues 或其他持久异步机制。
- QQ 是否允许模型回答中的 URL 只能在测试群验证；发送失败会作为 QQ 业务错误记录，不会向群里回显上游详情。
- Cloudflare Worker、远程 D1、QQ Webhook 和基础 `ping`/`DS ask` 已通过；聊天已取消频率限制，仅保留费用预算。
