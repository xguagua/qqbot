import { UNKNOWN_COMMAND_REPLY } from "./router";

interface HelpEntry {
  aliases: readonly string[];
  text: string;
}

const HELP_ENTRIES: readonly HelpEntry[] = [
  {
    aliases: ["ping"],
    text: "ping\n健康检查。用法：ping，回复 pong。所有成员可用。",
  },
  {
    aliases: ["chat", "聊天", "普通文本"],
    text:
      "普通文本聊天\n直接发送不以 / 开头且不是 ping 的文本，与流萤角色聊天。\n" +
      "可附带文件。",
  },
  {
    aliases: ["/ds ask", "ds ask", "ask"],
    text:
      "/DS ask <问题> [附件]\n调用当前群配置的 DeepSeek 模型问答；可附带文件。\n" +
      "所有成员可用，受群限流和费用上限约束。",
  },
  {
    aliases: ["/ds set", "ds set"],
    text:
      "/DS set model|think|spm <值>\n修改当前群模型、思考强度或 System Prompt。仅管理员可用。",
  },
  {
    aliases: ["/ds set model", "ds set model"],
    text: "/DS set model <deepseek-flash|deepseek-v4-pro>（仅管理员）",
  },
  {
    aliases: ["/ds set think", "ds set think"],
    text: "/DS set think <none|low|high|max>（仅管理员）",
  },
  {
    aliases: ["/ds set spm", "ds set spm"],
    text: "/DS set spm <System Prompt>（仅管理员，最长 1000 字）",
  },
  {
    aliases: ["/ds clear", "ds clear"],
    text:
      "/DS clear model|think|spm\n将当前群指定字段恢复默认值，其他字段保持不变。仅管理员可用。",
  },
  {
    aliases: ["/ds query", "ds query"],
    text:
      "/DS query model|think|spm\n查询当前群配置。query spm 会公开返回当前 System Prompt。仅管理员可用。",
  },
  {
    aliases: ["/ds list", "ds list", "list"],
    text:
      "/DS list [model|think]\n列出可用模型或思考等级；省略参数时同时列出两者。所有成员可用。",
  },
  {
    aliases: ["/help", "help"],
    text: "/help [Command]\n查看全部命令或单条命令帮助。",
  },
];

function normalizeCommand(command: string): string {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function helpReply(command = ""): string {
  if (command.trim() === "") {
    return [
      "可用命令：",
      "",
      "ping — 健康检查，回复 pong",
      "普通文本 — 与流萤聊天，可附文件",
      "/help [Command] — 查看帮助",
      "/DS ask <问题> [附件] — 向 DeepSeek 提问",
      "/DS set model|think|spm <值> — 修改本群配置",
      "/DS clear model|think|spm — 恢复本群配置默认值",
      "/DS query model|think|spm — 查询本群配置",
      "/DS list [model|think] — 查看可用模型或思考等级",
      "",
      "普通聊天与 /DS ask 可附带最多 3 个文件，总大小不超过 8 MB。",
    ].join("\n");
  }

  const normalized = normalizeCommand(command);
  const entry = HELP_ENTRIES.find((candidate) =>
    candidate.aliases.some((alias) => normalizeCommand(alias) === normalized),
  );
  return entry?.text ?? UNKNOWN_COMMAND_REPLY;
}
