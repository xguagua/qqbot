#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${project_dir}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "错误：当前目录不是 Git 仓库，无法读取提交 ID。" >&2
  exit 1
fi

commit_sha="$(git rev-parse HEAD)"
deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "警告：工作区包含未提交或未跟踪的变更。" >&2
  echo "部署仍会记录当前 HEAD ${commit_sha}，但这些工作区变更不会对应到该提交。" >&2
fi

echo "部署提交：${commit_sha}"
echo "部署时间：${deployed_at}"

pnpm exec wrangler deploy \
  --strict \
  --domain qqbot.xguagua.cc.cd \
  --var "GIT_COMMIT_SHA:${commit_sha}" \
  --var "DEPLOYED_AT:${deployed_at}" \
  --message "deploy ${commit_sha} at ${deployed_at}"
