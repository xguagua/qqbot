import type { RuntimeConfig } from "../config";

function safeVersionValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").slice(0, 200);
}

export function versionReply(runtime: RuntimeConfig): string {
  return [
    "当前版本",
    `Git commit: ${safeVersionValue(runtime.gitCommitSha)}`,
    `部署时间: ${safeVersionValue(runtime.deployedAt)}`,
  ].join("\n");
}
