# 参与贡献（Contributing）

欢迎向 **Git-Graveyard** 提交 Issue 与 Pull Request！

## 开始之前

- 改动较大或涉及架构/门禁规则调整时，请先开 Issue 说明思路，确认边界后再动手。
- 严禁提交 `.agent-ws/`、`memory/`、`01_evidence/`、`.env`、真实 API 密钥、Token、本机绝对路径或开发机 SSH 地址。
- 请遵守根目录 [AGENTS.md](./AGENTS.md) 中的核心边界：
  - 对上游源仓库保持只读（不 push、不提 PR、不发 Issue 或评论）；
  - 任务只有在 Grimoire gate 通过且 Warden 给出 `approve`（`candidateSha256` 一致）后才允许合并，不可绕过门禁。

## 本地开发环境

要求 Node.js 24+（与 CI 保持一致）：

```bash
npm ci
npm run dev
```

## 提交 PR 前的自检

在本地运行以下检查，并在 PR 描述中附上实际运行结果：

```bash
./node_modules/.bin/tsc --noEmit   # TypeScript 类型检查
npm test                           # 或 ./node_modules/.bin/tsx --test test/**/*.test.ts*
npm run build                      # Next.js 生产构建
npm run test:e2e                   # 若改动了前端页面、路由或交互
```

## 提交与 PR 规范

- 提交信息建议使用约定式前缀：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 新功能或规则修复需附带对应单元测试或属性测试（`test/`）。
- 提交前运行 `git status --porcelain` 确认无临时文件或私有目录残留。

## 许可证

向本仓库提交的代码将按 [MIT License](./LICENSE) 发布。
