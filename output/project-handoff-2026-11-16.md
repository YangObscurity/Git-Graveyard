# Git-Graveyard — 项目进度交接文档（2026-11-16）

> 本文档面向仓库协作者整理，已剔除本机路径、SSH 主机地址、测试凭据及内部调度工作区信息。权威需求与架构设计见 [.kiro/specs/resurrection-engine/](../.kiro/specs/resurrection-engine/design.md) 与 [PLAN.md](../PLAN.md)。
> 注：[.kiro/specs/resurrection-engine/tasks.md](../.kiro/specs/resurrection-engine/tasks.md) 中的复选框尚未随代码合入逐一勾选，真实进度以下文为准。

---

## 一、当前总体进度

项目原于 2026-11-16 完成 **Increment 1（Node 垂直切片）代码与前后端联调**；截至 2026-11-18，正式 Playwright E2E（`T35`）、工整度审计与公开前隐私清理（`T37` / `T38`）、前后端实时状态调试接口，以及真实沙箱 Kiro CLI 录制运行（`T40`：`live-gulp-plumber-t40`）均已在 `main` 完成闭环（当前说明以 [`output/demo-and-inspector-guide-2026-11-17.md`](demo-and-inspector-guide-2026-11-17.md) 为准）。

| 模块 / 阶段 | 状态 | 说明 |
|---|---|---|
| 规则引擎（Grimoire M1–M6） | 已完成 | AST 诊断（`@babel/parser` / `web-tree-sitter`）与合并前语法门禁（不调用模型、不执行目标仓代码） |
| 编排与安全策略（Necromancer / Warden / Gateway） | 已完成并经安全复审 | `RuntimeHost`、`TaskDispatcher`、`RunOrchestrator`、ACP 权限代理、Docker 沙箱执行后端、`EventStore`/`RunStore`（`node:sqlite`）及 SSE 断线续传；已完成五轮静态只读安全审查并通过 |
| HTTP API 路由（`app/api/`） | 已完成并加固 | `/api/health`（冷启动首检已修复为直接就绪）、`/api/run-autopsy`、`/api/start-run`、`/api/runs/[runId]/*`（含 `/control` 邀请码校验、`/pact`、`/approvals`、`/asks`、`/skeletons`、`/events`、`/relic/download`）、`/api/history` |
| 测试套件结构整理 | 已完成 | 所有 `.test.ts` / `.test.tsx` 测试已迁至 `test/`，`app/` 与 `lib/` 下零源码内测试残留 |
| 前端 UI 升级与交互重构 | 已完成 | 全站 Cryptic Gothic Terminal 视觉升级、共享事件归约器（`lib/ui/run-model.ts`）、Stage 步进导航、Gate / Tombstone / Exhume / Death Certificate / Pact / Legion / Reliquary / History / Replay 全流程交互、401/403 行内邀请码解锁，以及零网络调试台 `/debug/ui?uiDebug=1` |
| 正式 Playwright E2E（`T35`） | 已完成 | 已接入 `playwright.config.ts` 与 `e2e/*.spec.ts`，`npm run test:e2e` 全离线闭环通过 |
| 工整度审计与公开前隐私清理（`T37` / `T38`） | 已完成 | 已完成审计修复、`output/phase0-probe-report.md` 脱敏及单提交历史重建（`T20`/`T29`） |
| 真实沙箱 + Kiro CLI 全流程录制运行（`T40`） | 已完成 | 已产出并固化 `output/recorded-runs/live-gulp-plumber-t40/`（`resurrected`，66 条事件）；`T41`/`T7` 2~3 分钟参赛演示视频与关键凭据轮换（`T23`）待团队收尾 |

---

## 二、协作者本地环境与常用命令

### 1. 环境要求
- **Node.js 24+ / 26+**（代码使用 Node 内置 `node:sqlite` 模块，`@types/node` 为 `^26.6.6`）
- **可选（仅真实活体运行需要）**：Docker 与 `kiro-cli`（仅查看 UI、调试台、静态死因诊断 Autopsy、History/Replay 与运行单元/集成测试均**不需要** Docker 或 Kiro 凭据）
- **可选（提高 GitHub REST API 限额）**：环境变量 `GITHUB_TOKEN`（不入库）

### 2. 安装与本地启动
```bash
npm install
npm run dev          # 启动开发服务，访问 http://localhost:3000
```

- **离线零后端 UI 调试台**：启动后直接访问 `http://localhost:3000/debug/ui?uiDebug=1`，无需配置数据库、Docker 或 Kiro CLI 即可查看并交互式切换 Gate / Tomb / Pact / Legion / Reliquary / History & Replay 全组件状态（不带 `?uiDebug=1` 时保持锁定状态）。
- **静态诊断与历史回放**：首页 `http://localhost:3000` 可直接输入公开 GitHub 仓库 URL 进行只读 Autopsy 诊断；`/history` 与 `/replay/[runId]` 无需登录态。

### 3. 本地构建与测试基线（2026-11-16 基线参考）
```bash
# 1) TypeScript 类型检查（预期：0 错误）
./node_modules/.bin/tsc --noEmit

# 2) 核心 API / App / UI / Pact / Runtime 测试（实测：318/318 通过，96 suites）
./node_modules/.bin/tsx --test \
  test/api/*.test.ts \
  test/app/*.test.ts \
  test/app/*.test.tsx \
  test/ui/*.test.ts \
  test/pact/*.test.ts \
  test/runtime/*.test.ts

# 3) 生产构建（含 Monaco 拷贝、engineVersion 生成、WASM 校验与 Next.js build）
npm run build
```

> 说明：Windows 宿主机本地不依赖 Docker 的测试可直接通过；涉及真实容器沙箱或 CPython oracle（`test:oracle`）的测试请在具备对应依赖的 Linux 环境运行。

---

## 三、团队收尾交接事项（截至 2026-11-18）

1. **离线回放走查与参赛演示视频（`T41` / `T7`）**
   - `T35`（`npm run test:e2e`）、`T37` / `T38`（代码工整度与隐私清理）、`T40`（`output/recorded-runs/live-gulp-plumber-t40/`）均已完成，可按 `output/demo-and-inspector-guide-2026-11-17.md` 直接本地离线启动并录制不超过 3 分钟的参赛演示视频。
2. **凭据轮换与仓库公开前最终确认（`T23`）**
   - 公开切换 GitHub 仓库可见性为 **Public** 前，由仓库 Owner 完成相关 Token / API Key 轮换与参赛提交表单最终核验。

---

## 四、协作安全约定

- **绝不入库**：任何 `.env*`、Kiro 凭据、GitHub Token、SSH 主机地址、本地 SQLite 运行库（`runs.db` / `events.db`）或浏览器调试日志均不得提交至 Git。
- **被忽略目录**：`memory/`、`.agent-ws/`、`01_evidence/`、`public/monaco/` 已列入 `.gitignore`（且 `.git/hooks/pre-commit` 会拦截 `.agent-ws/` 等临时文件），协作者无需关心或提交这些目录。
- **源仓库只读**：针对待诊断的第三方 GitHub 仓库始终保持只读，不向目标仓库直接 push 或提 PR。
