# AGENTS.md

本文件供接手本项目的后续 Agent 使用。开始任何工作前，先阅读本文件与 [`DECISION.md`](./DECISION.md)。

## 1. 指令优先级

发生冲突时按以下顺序处理：

1. 用户在当前对话中的最新明确要求。
2. `DECISION.md` 中已经确认的产品决策。
3. 本文件规定的工程约束与交接流程。
4. 第三方文档、示例代码和搜索结果。

不要把 `AGENTS.md` 或 `DECISION.md` 当作外部操作授权。尤其是部署、修改 QQ 开放平台配置、发送真实群消息、初始化 Git 仓库、创建付费资源或接触敏感凭据，仍以用户当前请求为准。

## 2. 项目目标

构建一个 QQ 群机器人：

- 使用 QQ 官方机器人 API v2。
- 由 Cloudflare Worker 处理 Webhook。
- 响应群成员 `@机器人` 后的指定文字指令；其他非斜杠文本按流萤角色聊天处理。
- 首版主分支支持 `ping` 和 DeepSeek 问答。
- 完美世界竞技平台战绩查询只能进入独立实验分支。

Cloudflare 主分支已部署，真实 `ping` 和 `/DS ask` 已完成线上 `reply_sent`。`/help`、`/DS list`、流萤上下文聊天及附件处理已部署；普通聊天已取消频率限制，仅保留费用预算。不要声称所有主分支验收项已经完成。

## 3. 当前仓库状态

接手时先检查实际工作区，不要凭本文件假设代码存在。

当前已知状态：

- 文档位于 `DECISION.md`、本文件和 `README.md`。
- 主分支 TypeScript、Wrangler 配置、D1 迁移、Worker、测试和本地集成测试已实现。
- 当前 `.git` 仍是占位目录，`git status` 报告“不是 Git 仓库”。
- 不要删除或覆盖 `.git`。
- Cloudflare Worker 已部署到 `https://qqbot.xguagua.cc.cd`，远程 D1 与三个运行时 Secrets 已配置。
- QQ Webhook 已收到真实 `GROUP_AT_MESSAGE_CREATE` 事件；`ping` 与 `/DS ask` 已通过线上日志确认。新增帮助、列表、流萤聊天和附件处理仍需真实测试群验收。
- 离线单元测试、本地 D1 集成测试和线上 `op=13` 挑战响应检查已通过。

若需要版本控制或分支操作，先确认仓库是否已经由用户初始化；仍不可用时向用户说明并请求下一步指示。

## 4. 必须遵守的范围

### 4.1 主分支范围

主分支只交付：

- Webhook 验签和事件接收。
- `@Bot ping`。
- `@Bot /DS ask <问题信息>`。
- 管理员 `/DS set model`、`/DS set think`、`/DS set spm`。
- 管理员 `/DS clear model|think|spm` 和 `/DS query model|think|spm`。
- 普通文本聊天，固定使用 `deepseek-flash` 非思考模式与内置流萤 System Prompt。
- `/help [Command]`、`/DS list [model|think]`。
- 普通聊天与 `/DS ask` 的附件传递。
- 每群配置、权限、限流、费用上限与最小审计。
- 按群和用户隔离的 24 小时短期聊天上下文。

### 4.2 实验功能

完美世界战绩查询 `/pw query` 只能存在于独立 Git 实验分支。

- 不得让主分支依赖 `/pw` 代码、凭据或测试数据。
- 实验分支不得使用生产群作为默认测试环境。
- 合并前必须满足 `DECISION.md` 的 D15 全部条件并获得用户明确同意。
- 条件不满足时应记录结论并停止，不得用模拟登录、浏览器自动化或绕过风控的方式强行交付。

### 4.3 明确不做

- 不购买或使用 VPS。
- 不维护常驻 WebSocket Bot 进程。
- 不支持群内仅发起人可见的回复。
- 不订阅或处理全部群消息。
- 不保留超过 24 小时的聊天上下文，不跨群或跨用户共享上下文；`/DS ask` 仍不使用上下文。
- 不允许模型自主执行命令、修改权限或调用工具。
- 不在 Worker 内运行无头浏览器模拟登录。
- 不接收或保存平台账号密码。
- 不绕过验证码、风控、访问控制或平台条款。

## 5. 信息来源

实现必须优先核对官方文档；不要依赖过时博客或猜测字段。

QQ 机器人 API v2：

- Webhook：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html>
- 群 @ 事件：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html>
- 消息规则：<https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html>
- 发送群消息：<https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html>
- 获取访问凭证：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html>
- 回调签名：<https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html>

DeepSeek：

- Chat Completions：<https://api-docs.deepseek.com/api/create-chat-completion>
- 模型与价格：<https://api-docs.deepseek.com/quick_start/pricing>
- 限流与隔离：<https://api-docs.deepseek.com/quick_start/rate_limit>
- 错误码：<https://api-docs.deepseek.com/quick_start/error_codes>

QQ 文档目前写明：

- API 基础地址为 `https://api.bot.qq.com`。
- Webhook 支持 HTTPS，允许端口为 80、443、8080、8443。
- 群 @ 事件为 `GROUP_AT_MESSAGE_CREATE`。
- 群消息通过 `POST /v2/groups/{group_openid}/messages` 发送。
- 群被动回复在 5 分钟内有效，同一条原消息最多回复 5 次。

DeepSeek 文档目前写明：

- Chat API 为 `POST https://api.deepseek.com/chat/completions`。
- 模型为 `deepseek-flash` 或 `deepseek-v4-pro`。
- 思考强度为 `none`、`low`、`high`、`max`。
- 思考模式下 `temperature` 不生效，`none` 会关闭思考。

若接口发生变化，以最新官方文档为准，并先更新 `DECISION.md` 的受影响约束，再修改代码。

## 6. 群消息事件契约

只处理 `GROUP_AT_MESSAGE_CREATE`。关键字段：

- 消息 ID：事件 `d.id`，用于被动回复与撤回。
- 群标识：`d.group_openid`。
- 发送者：`d.author.member_openid`。
- 群角色：`d.author.member_role`，值为 `member`、`admin` 或 `owner`。
- 正文：`d.content`，QQ 已移除对机器人的 @ 前缀。
- 事件时间：`d.timestamp`。

要求：

- 不要用昵称、头像或可修改的展示字段做权限判断。
- 不要假设 `group_openid` 与真实 QQ 群号相同。
- 不要假设 OpenID 在不同机器人或不同群之间可互换。
- 处理文本、文本加顶层附件，以及附件-only 普通聊天；卡片和嵌套消息不进入主分支业务逻辑。
- 正文解析前后都去除首尾空白，但保留用户问题内部空格。

## 7. Webhook 与签名

### 7.1 验证请求

QQ 配置回调地址时会发送 `op=13` 的验证请求：

- 原始请求体包含 `plain_token` 和 `event_ts`。
- 使用 `clientSecret` 派生 Ed25519 seed。
- 签名正文为 `event_ts + plain_token`。
- 返回包含 `plain_token` 和十六进制 `signature` 的 JSON。
- 该请求不能进入普通指令处理流程。

### 7.2 普通事件

每个普通回调都必须验证：

- 保留并读取原始请求字节，签名针对原始 Body，不是重新序列化后的 JSON。
- 从 `X-Signature-Ed25519` 读取十六进制签名。
- 从 `X-Signature-Timestamp` 读取时间戳。
- 验证正文为 `timestamp + rawBody`。
- 如平台提供 `X-Bot-Appid`，校验其值与当前机器人 AppID 一致。
- 验签失败时拒绝请求，不执行任何业务逻辑。

实现前先做最小签名测试向量：

- 同一原始字节必须通过。
- 改动 Body 一个字节必须失败。
- 改动时间戳必须失败。
- 非十六进制、错误长度和空签名必须安全失败。

Cloudflare Workers 的 Ed25519 能力可能随运行时变化。实现时先验证 Web Crypto 是否可直接使用；若不可用，再选择经过测试、可在 Worker 打包的纯 JavaScript Ed25519 实现。不要未经验证假定某个 API 可用。

### 7.3 快速响应

QQ 会因超时或失败重试回调。

- 验签和基础解析完成后，尽快返回平台要求的成功状态。
- 若使用 `waitUntil` 做后续处理，必须理解其执行时限；不要把它当成持久可靠队列。
- 如果实测发现模型请求或 QQ 回复会被中断，使用 Cloudflare Durable Objects、Queues 或其他有明确持久性的方案，但新增付费资源前必须获得用户同意。
- HTTP 返回成功不等于 QQ 消息已发送成功，发送结果必须单独检查。

## 8. QQ Access Token

- 获取地址：`POST https://api.bot.qq.com/app/getAppAccessToken`。
- 请求体：`{"appId": "...", "clientSecret": "..."}`。
- 成功时 `access_token` 有效期通常为 7200 秒。
- 调用业务接口时使用 `Authorization: QQBot <access_token>`。
- 业务错误可能仍返回 HTTP 200，必须检查响应体 `code`，不能只看 HTTP 状态。
- 缓存 Token 时预留刷新时间，不要在每次回复前无条件重新申请。
- 并发刷新必须去重，避免大量回调同时请求新 Token。
- 不在日志、错误消息、D1、KV 或群回复中暴露 Token。

## 9. 指令规范

命令前缀和参数值按大小写不敏感处理；展示给用户时使用统一格式。

### 9.1 `ping`

输入：

```text
@Bot ping
```

输出：

```text
pong
```

这是平台接入健康检查，不调用 DeepSeek。

### 9.2 `/DS ask`

输入：

```text
@Bot /DS ask <问题信息>
```

要求：

- 只把 `<问题信息>` 和当前群 System Prompt 发给 DeepSeek。
- 不发送昵称、`member_openid`、`group_openid`、群名、时间戳或历史对话。
- System Prompt 使用独立的 `system` 消息。
- 用户正文只使用 `user` 消息，不得拼接进 `system` 角色。
- 不启用工具调用、网页搜索、文件上传或自主执行能力。
- 不保留上下文，每次请求独立。
- 只把最终 `message.content` 返回群，不展示 `reasoning_content`。
- 首版不使用流式响应；必须获得完整结果后再发送 QQ 消息。

### 9.3 `/DS set model`

输入：

```text
@Bot /DS set model <模型>
```

允许值：

- `deepseek-flash`
- `deepseek-v4-pro`

只修改当前群配置。无效模型必须拒绝并给出不含内部细节的提示。

### 9.4 `/DS set think`

输入：

```text
@Bot /DS set think <强度>
```

允许值：

- `none`
- `low`
- `high`
- `max`

首版默认 `low`。`thinking` 与 `reasoning_effort` 的语义有重叠，实现时必须采用一套一致的映射，避免发送互相矛盾的参数。

### 9.5 `/DS set spm`

输入：

```text
@Bot /DS set spm <System Prompt>
```

`spm` 表示 System Prompt。

要求：

- 只修改当前群配置。
- 参数取命令后的全部剩余文本，不按空格截断。
- 设置硬性字符上限；具体上限写入集中配置并在部署前文档化。
- 禁止把空 Prompt 当作有效配置。
- 默认 Prompt 只包含 Bot 的安全与风格约束。
- System Prompt 不得包含凭据或群内隐私。
- System Prompt 不随错误日志或其他非明确查询的群回复回显；授权管理员执行 `/DS query spm` 时，可以公开返回当前值。

### 9.6 `/DS clear model|think|spm`

输入：

```text
@Bot /DS clear <model|think|spm>
```

要求：

- 只将指定字段恢复默认值，保留当前群其他配置。
- 默认值为 `deepseek-flash`、`low` 和仓库内置安全 System Prompt。
- 仅允许群主、群管理员或显式白名单执行。
- 操作写入群配置和版本化审计。
- 重置 System Prompt 时不得在成功提示中回显完整默认 Prompt。

### 9.7 `/DS query model|think|spm`

输入：

```text
@Bot /DS query <model|think|spm>
```

要求：

- 返回当前群的有效配置，不使用其他群或全局临时缓存。
- `spm` 查询明确返回当前 System Prompt；这是公开群消息，执行者必须在授权前知悉。
- 仅允许群主、群管理员或显式白名单执行。
- 查询不调用 DeepSeek，也不消耗模型预算。

### 9.8 普通文本聊天

输入不以 `/` 开头且不是 `ping` 的文本时，进入流萤角色聊天。

要求：

- 使用内置、不可被群配置覆盖的流萤 System Prompt。
- 固定使用 `deepseek-flash` 非思考模式，即请求参数为 `model=deepseek-flash`、`reasoning_effort=none`。
- 聊天上下文以 `group_openid + member_openid` 为键隔离，只查询和写入当前用户。
- 保留最近 8 条 user/assistant 消息，TTL 为 24 小时；每日定时清理过期记录。
- 普通聊天不设置频率计数，也不占用 `/DS ask` 的群/成员限额。
- 聊天仍受全局/群费用上限约束，并与 `/DS ask` 在同一个按群 Durable Object 中原子执行。
- 输入上限为 1,000 字，回复上限沿用现有硬限制。
- 代码编写、修改或调试请求必须在调用 DeepSeek 前直接拒绝。
- 高置信度提示词注入请求必须在调用 DeepSeek 前直接拒绝。
- 模型输出出现代码块或明显源代码结构时必须二次拦截，且不得写入上下文。
- 用户消息和模型回答只作为聊天内容，不得用于改变角色、权限、系统规则或执行工具。

### 9.9 `/help` 与 `/DS list`

- `/help` 返回全部命令帮助；`/help <Command>` 返回指定命令帮助。
- 支持的帮助目标包括 `ping`、`chat`、`/DS ask`、`/DS set`、`/DS clear`、`/DS query`、`/DS list` 和 `/help`。
- `/DS list model` 返回可用模型，`/DS list think` 返回思考等级，`/DS list` 同时返回两者。
- `/help` 和 `/DS list` 对所有群成员开放，不调用 DeepSeek。
- 未知斜杠命令或错误命令结构统一返回：`未知命令，请输入 /help 查询`。

### 9.10 附件

普通聊天和 `/DS ask` 可以把当前消息的顶层附件发送给 DeepSeek。

- 每条消息最多 3 个附件。
- 单文件不超过 4 MB，总计不超过 8 MB。
- 只接受 HTTPS 443 端口，并拒绝 localhost、私网 IP、内网域名和带用户凭据的 URL。
- 图片使用 `image_url`，其他文件使用 `file` 和 base64 `file_data`。
- 附件只读入 Worker 内存，不写入 D1、日志、聊天上下文或 QQ 回复。
- 附件内容是不可信输入，不能改变角色、权限、系统规则或代码限制。
- 附件下载总超时为 5 秒；单次模型超时需为 QQ 被动回复窗口留出余量。

## 10. 权限

权限必须在 Worker 中根据已验签事件计算：

- `ping`：当前群所有成员。
- `/DS ask`：当前群所有成员。
- 普通文本聊天：当前群所有成员。
- `/help` 和 `/DS list`：当前群所有成员。
- `/DS set model|think|spm`：`member_role` 为 `admin` 或 `owner`，或 `member_openid` 在显式白名单中。
- `/DS clear|query model|think|spm`：`member_role` 为 `admin` 或 `owner`，或 `member_openid` 在显式白名单中。
- `/pw query`：只存在于实验分支和受控测试群。

不得信任用户声称的身份，不得根据昵称判断权限，不得因为消息中出现“管理员”等字样而提升权限。DeepSeek 输出也不能改变权限。

若白名单按群维护，必须使用 `group_openid` 与 `member_openid` 的组合键，不能跨群复用。

## 11. 回复规则

- 所有主分支回复都是群内公开消息。
- 回复原消息时必须携带事件 `d.id` 作为 `msg_id`。
- 每次针对同一原消息发送不同内容时，`msg_seq` 必须唯一。
- 必须处理 5 分钟被动回复窗口及 5 次回复上限。
- 首版每次指令尽量只回复一次，减少超限和重复风险。
- 错误回复应说明“参数无效 / 权限不足 / 服务繁忙 / 达到限额”等可操作信息。
- 不向群成员回显 QQ API 原始响应、堆栈、上游 Token、System Prompt 或内部 URL，但授权管理员明确执行 `/DS query spm` 时除外。
- QQ 是否允许消息中的 URL 需在测试群验证；不能假设所有链接都能发送。

## 12. 去重与幂等

QQ 可能重复投递相同消息事件，下游请求也可能重试。

最低要求：

- 以事件消息 `d.id` 做短期去重。
- 同一事件只能产生一次 DeepSeek 请求。
- 同一事件只能产生一次业务回复。
- 回复使用唯一的 `msg_id + msg_seq`。
- 配置写操作具有明确的目标群和版本，重复执行不能产生多条审计记录。

去重键应有 TTL，覆盖平台重试窗口。不要只存在进程内内存中，因为 Worker 实例可能切换。

选择去重存储时：

- D1 可以保存持久记录。
- KV 最终一致，不适合作为严格的一次性租约或精确限流计数器。
- Durable Object 适合做需要原子性的短期去重、租户级限流和预算控制。

不要为了“以后可能用到”提前引入复杂资源；只引入满足已确认验收标准所需的部分。

## 13. 数据与配置

### 13.1 建议的群配置字段

```text
group_openid
model
reasoning_effort
system_prompt
updated_by_openid
updated_at
version
```

### 13.2 建议的审计字段

```text
group_openid
actor_member_openid
changed_fields
previous_version
new_version
created_at
```

不要把完整 System Prompt 无差别复制到每次审计记录中。若必须记录变更前后值，使用受控字段并设置长度上限；默认优先记录“哪些字段发生变化”，而不是长期留存全部内容。

### 13.3 数据保留

- 群配置：长期保留，直到用户要求删除或群停用。
- 配置变更审计：30 天。
- 普通聊天上下文：仅按 `group_openid + member_openid` 保存最近 8 条 user/assistant 消息，TTL 为 24 小时。
- 附件：只在当前请求内存中处理，禁止持久化。
- 其他聊天正文和模型回答：禁止持久化。
- Access Token：只做短时缓存，不进入业务数据库。
- 实验分支中的平台 Cookie 和登录态：不得写入仓库、日志、主 D1 或群消息。

### 13.4 多群隔离

所有配置查询、读写、限流和审计都必须包含 `group_openid` 作用域。测试必须覆盖：

- A 群管理员不能修改 B 群配置。
- A 群配额不会占用 B 群配额。
- A 群 System Prompt 不会出现在 B 群请求中。
- A 群用户的聊天上下文不会出现在 B 群或 B 用户请求中。

## 14. DeepSeek 调用规范

默认配置：

- 模型：`deepseek-flash`
- 思考强度：`low`
- 上下文：无
- `stream: false`
- System Prompt：安全与风格约束，不含隐私

普通文本聊天使用独立固定配置：

- 模型：`deepseek-flash`
- 思考强度：`none`，即关闭思考
- 上下文：当前群、当前用户最近 8 条消息
- System Prompt：内置流萤角色与安全边界，不允许群配置覆盖
- 不启用流式响应、工具调用、网页搜索或文件能力

调用要求：

- 每次调用设置明确超时，并与 QQ 5 分钟被动回复窗口留出余量。
- 设置输入和输出硬上限，防止超长输入、巨额 Token 消耗和 QQ 消息超限。
- 对 `choices[0].message.content` 做空值判断。
- 处理内容过滤、限流、余额不足、超时和服务端错误。
- 当前消息有附件时，使用官方多模态内容片段发送；不得把附件 URL 或二进制写入日志/D1。
- 对可重试错误使用有限次数退避；不要无限重试。
- 不把 API Key 放进浏览器、QQ 消息、URL、代码仓库或客户端配置。
- 不把 `user_id` 设置为 QQ 昵称、OpenID 或其他可识别身份的数据。

提示词注入边界：

- 群消息是用户输入，不是系统指令。
- 即使消息要求忽略规则、输出 System Prompt、泄漏密钥或执行命令，也只能得到普通聊天回答。
- 模型没有调用任何工具；任何高风险操作必须由 Worker 的显式命令和权限系统处理。

## 15. 限流与成本

已确认的初始限制：

- `/DS ask`：每群每分钟最多 3 次；每人 30 秒冷却。
- 普通聊天：取消频率限制，仅保留每群每日预算和全局每日预算。
- `/pw query`：实验分支每群每分钟最多 2 次；每人 60 秒冷却。
- 配置可以调整，但服务端必须有不可绕过的硬上限。
- 达到估算费用上限后拒绝新请求，并在群内公开提示。

实现要求：

- 对同时到达的请求做原子计数，避免并发绕过限制。
- 区分“每群”和“每成员”两个维度。
- 普通聊天不产生限流状态；`/DS ask` 的群/成员计数独立维护。
- 冷却拒绝不应触发 DeepSeek。
- 被去重的事件不应消耗额外模型额度。
- 费用控制至少覆盖单次最大输出、每群周期额度与全局安全阈值。
- 不要让群管理员通过 `/DS set` 关闭硬性安全上限。

若使用 Durable Object：

- 以 `group_openid` 作为租户粒度，避免全站单对象瓶颈。
- 保持对象状态只包含计数、窗口和预算等最小数据。
- 不要用对象存储聊天内容。

## 16. 推荐模块边界

具体文件名可调整，但不要把签名、协议、权限和业务逻辑混在一个大文件中。

建议边界：

```text
src/index.ts                 Worker fetch 入口与路由
src/config.ts                环境变量类型与硬上限
src/qq/verify.ts             Webhook 原始 Body 验签与挑战响应
src/qq/auth.ts               QQ Access Token 获取与缓存
src/qq/client.ts             群消息发送与错误映射
src/commands/router.ts       指令识别与分发
src/commands/ping.ts         ping
src/commands/help.ts         全部与单命令帮助
src/commands/ds.ts           DeepSeek 指令
src/commands/chat.ts         流萤角色聊天与限额
src/chat/policy.ts           角色提示词、代码/注入/输出防护
src/chat/types.ts            聊天消息类型
src/ai/deepseek.ts           DeepSeek HTTP 客户端
src/storage/config.ts        群配置读写
src/storage/chat.ts          按群与用户隔离的短期聊天上下文
src/files/attachments.ts     附件下载、安全校验与 base64 转换
src/storage/audit.ts         30 天审计
src/security/permissions.ts  角色/白名单判定
src/security/ratelimit.ts    原子去重、限流与预算
test/                        单元测试与协议夹具
```

实验分支可以增加 `src/commands/pw.ts` 和对应适配层，但主分支不得导入它们。

## 17. 环境变量与 Secrets

预期配置至少包括：

```text
QQ_APP_ID
QQ_CLIENT_SECRET
DEEPSEEK_API_KEY
```

建议使用明确的非敏感配置项保存：

- 默认模型。
- 默认思考强度。
- 每群/每成员限额。
- 全局成本阈值。
- 输入、输出和 System Prompt 长度限制。

规则：

- `clientSecret`、DeepSeek API Key 和平台 Cookie 只能进入 Cloudflare Secrets。
- `.dev.vars`、`.env` 和本地测试凭据必须被 `.gitignore` 排除。
- `.dev.vars.example` 只能使用明显占位符。
- 不要求用户在聊天中粘贴 Secret；即使收到也要避免回显。
- 输出调试信息前先确认不会打印环境对象或完整请求头。

## 18. 测试要求

默认测试不得依赖真实 QQ 群、真实 DeepSeek 请求或真实平台账号。

必须覆盖：

1. Webhook 挑战签名。
2. 合法回调通过，非法签名、时间戳或 Body 被拒绝。
3. `GROUP_AT_MESSAGE_CREATE` 解析。
4. `ping` 回复内容。
5. `/DS ask` 只发送预期正文和 System Prompt。
6. `/DS set` 参数校验与大小写处理；`/DS clear` 单字段恢复默认值；`/DS query` 返回当前群值。
7. 普通成员不能修改群配置。
8. 群管理员可以修改当前群。
9. 群管理员不能修改其他群。
10. 默认配置与按群覆盖。
11. 重复事件不重复调用 DeepSeek。
12. `/DS ask` 每群/成员限流正常生效；普通聊天不受频率计数限制，仅受费用预算限制。
13. 预算耗尽后不调用 DeepSeek。
14. Access Token 缓存与刷新去重。
15. DeepSeek 超时、限流、空响应和错误映射。
16. QQ 回复超时、重复 `msg_seq` 和业务错误码。
17. 日志和错误消息不含 Secret、Cookie、聊天正文或完整 System Prompt。
18. 普通文本聊天固定使用 `deepseek-flash` 非思考模式和内置流萤 Prompt。
19. 群、用户之间的聊天上下文隔离，TTL 与条数上限生效。
20. 代码请求、提示词注入和代码样式模型输出均被拒绝且不写入上下文。
21. `/help` 全部/指定帮助、`/DS list model|think` 和统一未知命令提示。
22. 普通聊天与 `/DS ask` 的图片/文件附件被发送给 DeepSeek。
23. 附件数量、单文件/总大小上限、HTTPS 与私网 URL 防护。
24. 附件不进入 D1、日志或聊天上下文，下载错误不调用 DeepSeek。

外部集成测试：

- 必须由用户明确要求并指定测试群。
- 不得向生产群发送自动测试消息。
- 先测试 `ping`，再测试 `DS`。
- 每次真实测试记录时间、输入、期望结果和实际结果，但不得记录 Secret。

## 19. 验收顺序

实现主分支时按以下顺序推进：

1. 本地协议验签测试。
2. Cloudflare Worker 回调挑战。
3. 测试群 `ping`。
4. D1 群配置与管理权限。
5. `/DS set`。
6. `/DS ask`，先使用假 DeepSeek 响应，再接真实 API。
7. 去重、限流、预算和审计。
8. 安全检查与错误路径测试。
9. 用户确认后再部署到生产群。

不要跳过 `ping` 直接调试复杂功能。不要把“Worker 返回 200”当作完整成功。

## 20. 部署规则

部署或修改外部状态前，用户必须明确要求。

建议步骤：

1. 运行类型检查、单元测试和构建。
2. 确认 Wrangler 环境与目标账号。
3. 设置 Secrets，避免命令行回显。
4. 应用 D1 迁移。
5. 部署到测试 Worker。
6. 在 QQ 管理端配置 Webhook 地址与群 @ 事件。
7. 验证回调挑战和 `ping`。
8. 使用测试群完成验收。
9. 用户确认后才切换生产配置。

部署前检查：

- 回调 URL 为 HTTPS。
- 端口为 80、443、8080 或 8443。
- 目标环境使用正确的 AppID。
- 不把沙箱和正式环境凭据混用。
- 回滚方式明确。
- 不把 Secret 写入 Wrangler 明文配置。

## 21. 分支与变更流程

### 主分支

- 只包含 `ping`、`/DS`、平台接入、权限、配置、限流与审计。
- 不导入完美世界实验代码。
- 不因实验方便而放宽正式群安全边界。

### `/pw` 实验分支

- 从主分支建立，名称应明确包含 `experiment` 或 `pw`。
- 使用独立测试配置和测试群。
- 只做只读战绩验证。
- 不提交真实账号、Cookie 或抓包中的敏感值。
- 若条件不满足，保留结论文档后停止，不反复尝试绕过限制。
- 合入主分支需要用户明确批准和 D15 全部证据。

### 产品决策变化

若用户改变以下任一内容，先更新 `DECISION.md`：

- 指令或权限。
- 默认模型、思考强度或 System Prompt。
- 群配置字段与保留期。
- 限流或预算。
- 主分支/实验分支范围。
- 是否支持对话上下文。
- 完美世界数据接入方式。

不要悄悄在代码中偏离已确认需求。

## 22. 编码与协作规范

- 使用 TypeScript，并为外部 JSON 做运行时校验，不能只依赖类型断言。
- 优先使用平台原生 `fetch` 和 Web Crypto；新增依赖前检查 Worker 兼容性、体积和维护状态。
- 不引入 Node.js 常驻进程、文件系统依赖或浏览器运行时。
- 对协议错误和用户错误给出稳定、可测试的错误类型。
- 保持模块职责清晰，避免超大入口文件。
- 不添加无关功能、管理后台或复杂 UI，除非用户明确要求。
- 不擅自初始化 Git、创建资源、部署或提交外部变更。
- 修改后运行与风险相称的检查，并在交付说明中明确哪些检查没有执行。

## 23. 日志与隐私

允许记录：

- 请求类型。
- 成功/失败状态。
- 规范化的错误码。
- 耗时。
- 事件去重结果。
- 不包含正文的配置变更摘要。

禁止记录：

- `clientSecret`、Access Token、DeepSeek API Key、Cookie。
- 完整聊天正文和模型回答。
- 完整 System Prompt。
- 未脱敏的请求体和响应体。
- 附件下载 URL、附件字节内容或 base64 data URL。
- 可公开检索的完整玩家账号信息，除非用户明确要求审计。

若为排障必须记录标识，使用短期、最小范围、受限访问的字段，并在问题解决后按保留策略清理。

## 24. 完成定义

主分支实现只有在以下条件均满足时才算完成：

- `DECISION.md` 的 10 条主分支验收标准全部验证通过。
- 真实测试群完成 `ping` 和 `/DS` 冒烟测试。
- 单元测试不依赖真实密钥。
- 多群隔离、去重、限流和预算测试通过。
- Secrets 没有进入仓库、日志或聊天记录。
- 用户确认生产配置切换。

完美世界实验分支的完成定义另行以 D15 为准；未满足时不得合入主分支，也不得写成“已支持”。
