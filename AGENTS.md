# AGENTS.md — Git-Graveyard

## 优先级

用户当轮指令 > 本文件 > `.kiro/steering/`。

## 边界

- 输入：用户提交的 GitHub 仓库 URL。对源仓库只读：不 push、不提 PR、不发 issue 或评论；推送只去 Owner 自己的 fork，分支 `graveyard/<runId>`。
- 仓库代码只在每次运行的容器里执行；Kiro key、GitHub 凭据、开发机 SSH 地址不进容器，也不进本仓库。
- 输出：交付物进 `output/`，中间产物进 `.agent-ws/<task-id>/`。
- 抓来的第三方源码只留必要样本，放 `01_evidence/`。

## 验收

1. 死因诊断附可核验依据（依赖清单 file:line 或 API 字段）。
2. 任务只有在 Grimoire gate 通过、且 Warden 给出 approve（`candidateSha256` 一致）后才合并；被拒的任务重新派发、重新规划、跳过或停止，不允许绕过 Warden 合并。
3. 演示路径可复跑：History 里的真实录制运行可以回放，不需要模型；现场运行需要邀请码。

## 记忆

- 会话开始读 `memory/PROJECT.md` 与 `memory/TASKS.md`。
- 派发收工往 `memory/RUNS.md` 追加一行；会话结束写 1~3 条结论进 `PROJECT.md`。
- `output/` 与 `01_evidence/` 只追加。

## 提交

提交前跑 `git status --porcelain` 确认无临时文件；`.agent-ws/` 已 ignore，pre-commit 也会拦。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
