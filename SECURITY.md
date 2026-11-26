# 安全策略（Security Policy）

## 报告漏洞

请勿在公开的 Issue 或 PR 中披露安全漏洞。请使用 GitHub 的私密漏洞报告：打开本仓库的 **Security** 页，点击 **Report a vulnerability**。

报告中请尽量提供：受影响的提交或版本、复现步骤、影响范围，以及可行的修复建议。

## 重点关注范围

- **沙箱与凭据隔离**：Kiro CLI 密钥、GitHub 凭据、开发机 SSH 地址等不得进入运行目标仓库代码的容器，也不得写入版本库或日志。
- **合并闸门绕过**：绕过 Grimoire 静态门禁（M1–M6）或 Warden 审批（`candidateSha256` 一致性校验）的漏洞。
- **上游仓库只读边界**：任何导致对源仓库执行 push、提 PR、发 Issue 或评论的逻辑缺陷。
- **Web / API 安全**：`/api/runs/*`、`/api/admin/*`、`/api/debug/*` 的邀请码或会话鉴权绕过、路径穿越、命令注入或前端 Diff/报告展示中的 XSS。
- **CI 供应链安全**：工作流权限过宽、Fork PR 触发密钥泄露或未固定版本的第三方 Action。

## 支持的版本

仅对 `main` 分支的最新提交提供安全修复。

## 密钥与隐私规范

提交、Issue 和 PR 中严禁包含真实 API 密钥、令牌、私钥、本机绝对路径、SSH 地址或工作区私有目录（`.agent-ws/`、`memory/`、`01_evidence/`）。环境变量仅放在本地 `.env`（已加入 `.gitignore`）。本仓库在 CI 中启用了 `gitleaks`、`opengrep`、`trivy` 与私有路径扫描。
