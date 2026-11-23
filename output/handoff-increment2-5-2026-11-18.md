# Git-Graveyard 团队交接稿：Increment 1 完成基线与 Increment 2–5 续接清单

- 日期：2026-11-18
- 适用分支：`main`
- 交接说明：前置 **Increment 0（Phase 0 探针与技术验证）** 与 **Increment 1（Node 垂直切片、全站 UI、前后端实时状态检查、离线 E2E 与真实沙箱录制 `live-gulp-plumber-t40`）** 已全部跑通验收并封版；早期阶段性交付文件（原 `project-handoff-2026-11-16.md` 与 `phase0-probe-report.md`）已从 Git 追踪列表移出归档，避免队友后续推进 **Increment 2–5** 时产生合并或文档口径冲突。

---

## 一、已完成并移交的基线（Increment 0 + Increment 1）

你直接基于 `main` 拉取代码后，即可获得已经联调跑通的完整原型系统：

### 1. 前端路由与组件（`app/` + `components/`）
| 路由 / 调试入口 | 页面能力 | 对应关键文件 |
|---|---|---|
| `/` | Gate 入口：仓库 URL 校验、`HealthBadge`、邀请码入队、最近真实录制记录 | `app/page.tsx`, `components/GateView.tsx` |
| `/tomb/[owner]/[repo]` | Tombstone & Exhume：无模型 Grimoire 静态死因诊断、`DeathCertificate` 基线结果、排队态 | `app/tomb/[owner]/[repo]/page.tsx`, `components/TombstoneView.tsx`, `components/ExhumeView.tsx` |
| `/runs/[runId]/pact` | Pact 契约编辑、强锁定检查项（不可移除）、预算设置、审批触发 Legion | `app/runs/[runId]/pact/page.tsx`, `components/PactEditor.tsx`, `components/PactBudgetSettings.tsx` |
| `/runs/[runId]/legion` | Legion 实时监控（SSE + `Last-Event-ID` 续传）、Skeleton 卡片、审批/提问交互、暂停恢复与邀请码解锁 | `app/runs/[runId]/legion/page.tsx`, `components/LegionDashboard.tsx` |
| `/runs/[runId]/relic` | Reliquary 圣物室：Outcome、Before/After 表、统一 diff（Monaco + `<pre>` 回退）、任务台账、SHA-256 产物下载 | `app/runs/[runId]/relic/page.tsx`, `app/runs/[runId]/relic/download/route.ts`, `components/ReliquaryView.tsx` |
| `/history` & `/replay/[runId]` | 真实录制历史与带 `Replay` 锁的 `seq` 逐帧回放（禁止破坏性控制按钮） | `app/history/page.tsx`, `app/replay/[runId]/page.tsx`, `components/ReplayPlayer.tsx` |
| `/debug/ui?uiDebug=1` | UI 预设矩阵展示台、`Live Runtime Inspector` 实况检查器、Dev Sandbox 驱动器与任意页 `?uiDebug=1` 悬浮 HUD | `app/debug/ui/page.tsx`, `components/debug/UiDebugGallery.tsx`, `components/debug/LiveStateInspector.tsx`, `components/debug/UiDebugLiveHud.tsx` |

### 2. 后端服务、执行沙箱与调试 API（`lib/` + `app/api/`）
- **核心编排与调度**：`lib/orchestrator/run-orchestrator.ts`、`lib/scheduler/{scheduler,dispatcher,candidate-submission}.ts`、`lib/runtime/runtime-host.ts`、`lib/lifecycle/{lifecycle-manager,outcome-evaluator,report-step,run-finalizer,artifact-collector}.ts`。
- **Kiro CLI 监督与隔离**：`lib/supervisor/{skeleton-supervisor,acp-client,acp-session,acp-transport,skeleton-env,event-tap,budget-caps,model-allowlist}.ts`、`lib/broker/permission-broker.ts`、`lib/gateway/{mcp-gateway,execution-tools,collaboration-tools,approval-manager,command-policy}.ts`、`lib/agents/templates/*.md`（全 6 角色模板已入库）。
- **单机 Docker 动态容器后端**：`lib/backend/{execution-backend,instabox-docker-backend,docker-exec-stream,network-policy,connect-proxy,spec-validator,sync-validator}.ts`（默认 `EXECUTION_BACKEND=instabox-docker`，每轮/每任务动态创建、运行并销毁只读根目录、非 root、摘要钉死、代理隔离的容器）。
- **静态分析、门禁与安全隔离**：`lib/grimoire/*`、`lib/rules/{m2-manifest,m2-request,m3-m4-guidance,m5-m6-guidance}.ts`、`lib/warden/{warden-review,merge-gate}.ts`、`lib/merge/*`、`lib/security/{redactor,untrusted-content,symlink-scanner,scope-check,canary,credential-vault,host-policy,kiro-key-containment}.ts`、`lib/git/git-service.ts`。
- **存储、录制装载与调试路由**：
  - `lib/runs/{run-store,recorded-runs-loader}.ts`（Node SQLite）、`lib/events/{event-store,log-store,event-export}.ts`、`lib/runtime/{store-context,diagnostics}.ts`；
  - 已上线 API：`/api/health`（支持 `?detail=1`）、`/api/run-autopsy`、`/api/start-run`、`/api/history`、`/api/runs/[runId]{,/events,/pact,/approvals,/asks,/control,/skeletons/[skeletonId]}`、`/api/debug/{status,runs/[runId],sim}`；
  - CLI 巡检脚本：`scripts/dev-status.ts`（`npm run status`）与真实运行脚本 `scripts/run-live-resurrection.ts`。
- **真实沙箱录制产物与验证基线**：
  - 已在隔离 Linux Docker 宿主机跑通真实复活录制包：`output/recorded-runs/live-gulp-plumber-t40/`（目标仓库 `floatdrop/gulp-plumber`，`outcome: resurrected`，`66` 条事件，5 个交付产物）；
  - 已验证：Playwright 离线 E2E `npm run test:e2e`（`3/3` 通过）、TypeScript `npm run typecheck`（0 错误）、`npm run build`、Linux 全量 `tsx --test`（158 个测试文件 / 551 suites，**2341/2341 通过**）、以及 GitHub Actions CI（含 `gitleaks` 隐私扫描）。

---

## 二、队友克隆仓库后的本地启动与动态环境机制

详细离线检查台与回放操作步骤另见 [`demo-and-inspector-guide-2026-11-17.md`](demo-and-inspector-guide-2026-11-17.md)。

### 1. 离线开发与验证（无需 Docker 与 Kiro 凭据）
要求 **Node.js 24+**（内置 `node:sqlite`）：

```bash
npm install
npm run typecheck    # tsc --noEmit
npm run status       # 核对本地 SQLite 存储、录制运行、探针门禁与本机工具链
npm run dev          # http://localhost:3000（可访问 /history、/replay/live-gulp-plumber-t40、/debug/ui?uiDebug=1）
npm run test:e2e     # Playwright 离线全链路 E2E（含 Gate -> Pact -> Legion -> Reliquary -> Replay）
```

### 2. Kiro CLI 如何动态读取你的本机环境
克隆仓库后**不需要**写死任何个人路径或密钥，代码会自动读取运行者本机的 Kiro 环境：
1. **二进制自动发现**：`RunOrchestrator`、`TaskDispatcher` 与 `probeToolchains()` 会自动将当前用户的 `~/.local/bin` 拼入 `PATH` 并探测 `kiro-cli`。
2. **认证动态切换**：
   - 若设置了环境变量 `KIRO_API_KEY`，`buildSkeletonEnv()` 直接将该 Key 注入隔离的 `kiro-cli` 子进程；
   - 若未设置 `KIRO_API_KEY`，`provisionSkeletonEnvironment()`（`lib/supervisor/skeleton-env.ts`）会自动检查 `os.homedir()/.local/share/kiro-cli`，并在每个 Skeleton 隔离 `HOME` 下建立符号链接复用你本机已经登录的 `kiro-cli` 认证状态（Linux/macOS 原生支持；Windows 如无 symlink 权限建议直接配置 `KIRO_API_KEY`）。
3. **环境变量与模型约束**：
   - 每个 `kiro-cli acp` 子进程只接收 4 个环境变量：`KIRO_API_KEY`、`KIRO_HOME`、`HOME`、`PATH`；工具执行通过宿主机 `McpGateway` 穿透进容器，Kiro 凭据不进入容器。
   - 模型固定按角色分配（见 `lib/agents/model-allowlist.ts`）：`planner` / `warden` → `claude-opus-5.5`、`bonesetter` / `soul-stitcher` → `claude-sonnet-5.5`、`exhumer` / `scribe` → `claude-haiku-5.5`（禁用 `auto`）。

### 3. 容器执行后端现况
- 当前 `EXECUTION_BACKEND` 默认为 `instabox-docker`（单机 Docker 动态启停 Runbox / Auditbox 容器，已跑通 `live-gulp-plumber-t40`）。
- 若要在本地跑真实复活（非 `/api/debug/sim` 仿真），宿主机需要可用的 Linux Docker daemon、已拉取或可构建的基础镜像（默认将 `node:22-bookworm` 解析为 `@sha256:...` 固定摘要）以及可用 Kiro 凭据；注意 `node e2e/start-e2e-server.mjs` 仅供 E2E / 离线演示，带 `DISABLE_AUTO_ORCHESTRATOR=1`，正常执行现场队列请用 `npm run dev` 或 `npm run start`（或直接用 `npx tsx scripts/run-live-resurrection.ts`）。

---

## 三、待队友继续收尾的任务清单（Increment 2–5）

以下任务的权威需求、设计与验收细则全部位于 `.kiro/specs/resurrection-engine/`（`requirements.md`、`design.md`、`tasks.md`）。本节逐项披露 **待实现目标**、**当前代码已有基石与缺口**、**预期产物/验收**。

---

### Increment 2：3 次真实录制运行与 E11 运行参数校准（`tasks.md` Task 17–18）

| 任务 | 目标与细则 | 当前代码状态 | 交付物 / 验收标准 |
|---|---|---|---|
| **Task 17.1** | `SettingsStore`：持久化保存 E11 默认上限（Warden 打回轮次、prompt 墙钟、单 run 墙钟、静默 Skeleton 阈值、审批等待、队列空闲阈值），缺项拒绝启动，记录变更审计日志，并统计 `EventStore` 中已完成的录制 run 次数（满 3 次置 `recalibrationRequired=true`） | **未创建** `lib/admin/settings-store.ts`；当前超时/上限以默认值或 `caps` 传入为主 | `lib/admin/settings-store.ts` + 单测 |
| **Task 17.2–17.3** | `calibrate-e11.ts`：聚合前 3 次已完成真实录制运行的实测耗时与打回分布，生成 JSON/Markdown 校准对比报告并支持写入 `SettingsStore` | **未创建** `scripts/calibrate-e11.ts` 与 `test/admin/calibrate-e11.test.ts` | 校准脚本 + 测试全绿 |
| **Task 18 Checkpoint** | 在 `live-gulp-plumber-t40`（第 1 次）基础上，再跑通并固化另外 **2 个不同真实仓库**的完整沙箱录制运行，完成校准 | 已有 `1` 个录制包（`output/recorded-runs/live-gulp-plumber-t40/`） | 至少 `3` 份真实录制 runs + 已校准 E11 参数 + `test:props` / `test:golden` 通过 |

---

### Increment 3：v1 全量扩展能力、Admin/Kiro 页面与全站体验（`tasks.md` Task 19–27）

1. **Task 19 — Python 2→3 完整自动修复、Deterministic Grimoire Bundle 与 CPython Oracle**
   - **现状缺口**：`lib/rules/` 目前只有 `m2-manifest.ts`、`m2-request.ts`、`m3-m4-guidance.ts`、`m5-m6-guidance.ts`；`lib/grimoire/` 目前无 `python-gate.ts` 与 `bundle.ts`；`package.json` 已预留 `"test:oracle": "tsx test/oracle/cpython-oracle.test.ts"`，但 `scripts/test-oracle.py` 与 `test/oracle/cpython-oracle.test.ts` 均尚未实现。
   - **待完成**：
     - 实现 `lib/rules/m1-python.ts`（`print`、`except`、unicode、dict 迭代器等 M1 规则及 `py2_residue` 标记）与 `lib/grimoire/python-gate.ts`（单调降低语法错误与 Python 2 残余、`m1-clean`/`m1-partial`）；
     - 实现 `lib/grimoire/bundle.ts`（纯模板确定性输出 `requirements.md`/`design.md`/`tasks.md` + `scripts/fixtures/bake.ts` 完整联动）；
     - 实现 `scripts/test-oracle.py`（`ast.parse(..., feature_version=(3, 13))`）与 `test/oracle/cpython-oracle.test.ts`，并通过 P2/P4/P5/P7/P8/P9 属性测试。

2. **Task 20 — Bonesetter 独立收紧、并行 Soul-stitcher 与 Headless Fallback 完善**
   - **现状基石与缺口**：`lib/agents/templates/bonesetter.md`、多角色模型白名单、`lib/supervisor/skeleton-supervisor.ts` 中的 `Headless_Fallback` 分支及 `lib/scheduler/{scheduler,dispatcher}.ts` 均已存在；但默认并发测试基线锁定 `maxParallel = 1`，且独立的 `lib/acp/headless-fallback.ts`、`lib/acp/stream-parser.ts`、`lib/agents/bonesetter.ts`、`lib/scheduler/parallel-scheduler.ts` 与 `test/scheduler/parallel-bonesetter.test.ts` 尚待拆分/补全并验证多路并行与 `--resume-id` 约束。

3. **Task 21–22 — 完整 HITL 双向消息、硬阻断独立校验、Fork Push 接口、Admin 与 BudgetGovernor**
   - **现状基石与缺口**：
     - 已有：`lib/gateway/{collaboration-tools,approval-manager}.ts`、`lib/git/git-service.ts`（已含 `pushToFork`）、`lib/supervisor/budget-caps.ts`；
     - 缺口（对应 `.kiro/steering/structure.md` 列出的待补路由）：
       - `app/api/runs/[runId]/messages/route.ts` 与 `lib/messaging/message-service.ts`（Sent/Delivered/Acknowledged 状态机、`_session/steer` 与立即中断策略）；
       - `app/api/runs/[runId]/artifacts/route.ts`、`app/api/runs/[runId]/push-fork/route.ts`（弹窗确认推送 Owner Fork 分支 `graveyard/<runId>`）；
       - `lib/hitl/ask-manager.ts`、`lib/policy/hard-blocks.ts`、`lib/governor/budget-governor.ts`（80% `budget.warning`、100% `budget.exceeded`、Context 上限自动收尾、`P20` 属性测试 `test/props/caps-stop-new-work.test.ts`）；
       - `lib/admission/{invite-code,fifo-queue,admission-controller}.ts`（从 `/api/start-run` 内存队列与 `RunStore` 基础校验升级为含 IP 限流、独立 FIFO 队列与容量策略的服务）；
       - **Admin 控制面**：`lib/admin/{admin-session,kill-switch}.ts`、`app/api/admin/*` 与 `app/admin/page.tsx`（登录验证、邀请码在线生成/列表/吊销、预算修改、三档 `KillSwitchModal` 急停、审核脱敏 `admin.redaction`、发布 `admin.publish`、隐藏 `Removed by the owner` 与上线审计签字门禁）。

4. **Task 23 — Scribe 报告证据核验与系统启动/容器恢复**
   - **现状基石与缺口**：`lib/agents/templates/scribe.md`、`lib/lifecycle/report-step.ts`、`lib/runs/run-store.ts`（`reconcileOnBoot`）已存在；需补齐 `lib/scribe/{scribe-service,report-check}.ts`（强制校验 Scribe 报告数字与状态均有 `cmd:`/`file:`/`gh:`/`ev:` 依据，一次打回、二次失败降级丢弃叙述）、`lib/supervisor/failure-recovery.ts` 与 `lib/recovery/boot-reconciliation.ts`（pidfile 清理、容器 OOM/TTL 重建一次、GitHub 403/429 冷却）。

5. **Task 24–26 — 剩余全量 UI 状态、`TaskGraph`、诚实指标注册表、可访问性与 `Built with Kiro`**
   - **现状缺口**：
     - 页面路由缺口：`app/built-with-kiro/page.tsx` 与 `app/admin/page.tsx`；
     - 构件与测试脚本缺口：`package.json` 已定义 `"evidence:build": "tsx scripts/evidence/build-evidence.ts"`，需实现 `scripts/evidence/build-evidence.ts`、`test/ci/evidence-integrity.test.ts`、`lib/evidence/evidence-service.ts`、`components/OpenInKiroHandoff.tsx`（嵌入 Reliquary）；
     - 诚实指标与文案检查：`lib/metrics/{registry,formatters}.ts`（映射 `R4-13` M1–M31 指标，缺源展示 `not available`/`not reported`、`P14` 属性测试）、`components/GlossedTerm.tsx`、`lib/copy/claims-linter.ts`；
     - 高级 UI 状态与无障碍：`components/TaskGraph.tsx` + `components/TaskTable.tsx`、`components/LayToRestModal.tsx`、断线重连 `Last-Event-ID` 提示、`Silent for mm:ss`、Admin/History 异常态、`components/a11y/*` + `lib/a11y/*`（WCAG AA 对比度、焦点管理、Live Region）以及 Playwright `axe-core` 扫描通过（`test/e2e/accessibility.spec.ts` / 纳入 `npm run test:e2e`）。

6. **Task 27 Checkpoint**：完成端到端评委视角全旅程验证（含指标诚实性、`Built with Kiro`、`Admin`、可访问性 `axe-core`）。

---

### Increment 4：生产云端沙箱与 Promotion Gate 上线（`tasks.md` Task 28–30）

1. **Task 28 — `DockerCloudSandboxBackend`（Topology P-B）**：
   - 替换 `lib/backend/execution-backend.ts` 中当前抛出 `NOT_IN_V1` 的 `DockerCloudSandboxStub`，按 `lib/execution/docker-cloud-sandbox-backend.ts`（或归入 `lib/backend/`）接入真实 Docker Agentic Platform 云端沙箱：
   - 保持 Topology P-B：`kiro-cli` 仍在生产宿主机运行，目标仓库代码仅在云沙箱容器内执行；
   - 实现宿主机 worktree ↔ 云沙箱双向同步 `syncIn`/`syncOut`（复用并接实 `lib/backend/sync-validator.ts` 防穿行、符号链接、`.git/`/`.kiro/` 拒绝及 `node_modules`/`dist` 过滤）、TTL（默认 1 小时，最长续期 24 小时）、10 沙箱配额下最大 5 并发运行控制、禁止快照、重启通过 label 重接及常驻宿主机部署配置。
2. **Task 29–30 — Promotion Gate（E5 安全访问审计）与正式上线**：
   - 实现 `lib/audit/{promotion-gate,audit-schema,evidence-recorder,xr-verifier}.ts` 与 `scripts/audit/{run-security-audit,verify-xr-items,verify-credentials}.ts`；
   - 在切换到 `Production` 模式前依次执行 G1（上线前）与 G3（上线后）安全审计，验证 `XR-01..XR-03`，并将开发阶段的全部 Kiro key / Docker key / 邀请码 / GitHub tokens 作废换新（旧凭证验证失败），在正式生产 URL 通过 **Checkpoint 30**。

---

### Increment 5：Stretch 加分项（`design.md R4-18`）

- **`F21`**：Reliquary / Gate / API 完整端到端接入「仅在邀请码显式授权 + 用户二次确认后推送到 Owner 自己的 Fork 分支 `graveyard/<runId>`」。
- **`F24`**：在性能允许的开发机上开启多个 `Soul-stitcher` 并行执行。
- **`F25`–`F29`**：浏览器桌面通知（`F25`）、最低依赖版本 OSV 漏洞提示（`F26`）、分享卡片（`F27`）、容器内部运行时直挂 CPython `ast.parse` 门禁（`F28`）、Exhumer 分诊阶段只读子智能体 fan-out 展示（`F29`）。

---

### 参赛提交前团队收尾共同项
1. **`T7` 演示视频（<= 3 分钟）**：可直接使用已固化的 `live-gulp-plumber-t40` 按 `output/demo-and-inspector-guide-2026-11-17.md` 本地离线录制（涵盖 Gate → Tombstone → Pact → Legion → Reliquary → History/Replay）。
2. **`T23` 凭据轮换与仓库公开**：在正式提交或推广上线前，由仓库 Owner 轮换开发期 Token / API Key，酌情处理 GitHub 默认分支 Dependabot 告警，并将仓库可见性由 `PRIVATE` 切换为 `Public`。

---

## 四、已归档的早期文档说明
为避免后续推进 Increment 2–5 时旧版本交接稿和探针报告与新路线产生修改冲突：
- 原 `output/project-handoff-2026-11-16.md`（Increment 1 阶段交接）与 `output/phase0-probe-report.md`（Increment 0 探针阶段报告）已移出 Git 追踪列表，改名归档至本地未追踪目录 `01_evidence/archive/increment1-completed-2026-11-18/`。
- 后续所有代码与文档协同请统一以本文件、`output/demo-and-inspector-guide-2026-11-17.md` 以及 `.kiro/specs/resurrection-engine/` 为唯一现行基线。


---

## 五、2026-11-23 任务分工更新：Kiro CLI / Docker 沙箱任务归 Owner，纯代码与离线测试任务归队友

> **更新背景**：PR #1（`0ae9e1c`，macOS 登录复用、模型环境变量覆盖、Planner 覆盖率追问重试、Tombstone 按文件分组、Replay 单行摘要、已完成运行终态 UI 修复）与 PR #2（`3ce2a68`，mock PID 信号保护）已全部合入 `main`。
>
> **明确职责边界**：
> - **Owner 负责**：所有需要 **真实 `kiro-cli`（Claude 5.5 凭据）** 或 **真实 Docker 沙箱（Linux 宿主机容器 / Docker Cloud Sandbox 云沙箱）** 的实跑录制、容器生命周期实测、上线安全审计（G1/G3、`XR-01..XR-03`）及凭据轮换（`T23`）。
> - **队友（Teammate）负责**：所有 **纯代码模块、规则引擎、API 路由、前端 UI 状态、Mock/Fixture 单测、fast-check 属性测试与离线 Playwright E2E**（仅需本地 Node.js 24+，**无需** Claude 5.5 权限或 Docker 守护进程）。

### 1. 队友负责的纯代码与离线测试清单（Teammate Scope — No Kiro CLI / Docker Sandbox Required）

1. **PR #1 遗留的 2 项底层代码修复（`FIX-PR1`）**
   - **消除事件双写**：修改 `lib/gateway/approval-manager.ts`（`ApprovalManager.emitEvent()`）与 `lib/gateway/execution-tools.ts`，统一只通过单一路径写入 `EventStore`（不再既直接 `eventStore.append()` 又触发 `onEmitEvent -> RuntimeHost.emitEvent()` 重复 `append`），并更新 `test/gateway/approval-manager-rb3.test.ts` 的断言。
   - **无 `build` 脚本时的终检状态口径对齐**：当目标仓库无 `build` 脚本（Exhume 阶段记录为 `not run`）时，对齐 `final_check.result` 与 `BeforeAfterTable` 中的 build 状态表示，避免 Exhume 显示 `not run` 而终检显示 `buildPassed: true` 的口径不一致。
2. **Increment 2 纯代码部分（Task 17.1–17.3）**
   - 实现 `lib/admin/settings-store.ts`（`SettingsStore`：E11 默认上限初始化、缺项拒绝启动、变更审计日志、统计 `EventStore` 已完成录制 run 数满 3 次时置 `recalibrationRequired = true`）。
   - 实现 `scripts/calibrate-e11.ts`（读取 `EventStore` 聚合前 3 次已完成录制运行的分布并生成 JSON/Markdown 校准对比报告，支持 CLI 参数写回 `SettingsStore`）。
   - 编写 `test/admin/calibrate-e11.test.ts`（使用 fixture 事件流验证 `SettingsStore` 与 `calibrate-e11.ts`；真实的第 2、3 次沙箱运行由 Owner 录制后提供）。
3. **Increment 3 Python 2→3 规则、门禁与确定性 Bundle（Task 19.1–19.10）**
   - 实现 `lib/rules/m1-python.ts`、`lib/grimoire/python-gate.ts`、`lib/grimoire/bundle.ts`（并联动 `scripts/fixtures/bake.ts`）、`scripts/test-oracle.py`、`test/oracle/cpython-oracle.test.ts` 以及属性测试 P2/P4/P5/P7/P8/P9（`npm run test:oracle`、`npm run test:props`、`npm run test:golden`）。
4. **Increment 3 Bonesetter、Headless Fallback 解析器与并行调度代码（Task 20.1–20.4 代码与 Mock 测试）**
   - 实现 `lib/agents/bonesetter.ts`、`lib/acp/headless-fallback.ts`、`lib/acp/stream-parser.ts`、`lib/scheduler/parallel-scheduler.ts` 及基于 mock 子进程与本地 git worktree 的 `test/scheduler/parallel-bonesetter.test.ts`。
5. **Increment 3 双向消息、HITL、硬阻断、Fork Push 路由、Admission、BudgetGovernor 与 Admin 后端（Task 21.1–21.5 & Task 22.1–22.5）**
   - 实现 `lib/messaging/message-service.ts`、`lib/hitl/ask-manager.ts`、`lib/policy/hard-blocks.ts`、`/api/runs/[runId]/{messages,push-fork}` 等路由及 `test/props/no-upstream-writes.test.ts`（P15）。
   - 实现 `lib/admission/{invite-code,fifo-queue,admission-controller}.ts`、`lib/governor/budget-governor.ts`、`test/props/caps-stop-new-work.test.ts`（P20）、`lib/admin/{admin-session,kill-switch}.ts` 及 `/api/admin/*` 路由。
6. **Increment 3 Scribe 报告证据校验与恢复逻辑代码（Task 23.1–23.5 代码与 Mock 测试）**
   - 实现 `lib/scribe/{scribe-service,report-check}.ts`、`lib/supervisor/failure-recovery.ts`、`lib/recovery/boot-reconciliation.ts` 及基于 mock backend 的 `test/scribe/report-check.test.ts`、`test/recovery/failure-recovery.test.ts`。
7. **Increment 3 全量 UI 剩余状态、任务图、诚实指标注册表、Built with Kiro 页面与无障碍 E2E（Task 24–27）**
   - 实现 Task 24（各页剩余状态、`TaskGraph.tsx`/`TaskTable.tsx`、`LayToRestModal.tsx`、`app/built-with-kiro/page.tsx`、`app/admin/page.tsx`、`KillSwitchModal.tsx`）、Task 25（`lib/metrics/{registry,formatters}.ts` M1–M31 + P14、`GlossedTerm.tsx`、`claims-linter.ts`、`components/a11y/*` + `test/e2e/accessibility.spec.ts` Playwright `axe-core`）、Task 26（`scripts/evidence/build-evidence.ts`、`test/ci/evidence-integrity.test.ts`、`lib/evidence/evidence-service.ts`、`OpenInKiroHandoff.tsx`），并在本地离线通过 **Checkpoint 27**（`npm run test:props`、`npm run test:golden`、`npm run test:e2e`）。
8. **Increment 4 纯代码校验层（Task 28.2 & Task 29.1 离线逻辑）與 Increment 5 纯前端可选加分项**
   - `lib/execution/sandbox-sync.ts`（或 `lib/backend/sync-validator.ts` 扩展）纯文件同步过滤逻辑与单测；`lib/audit/{promotion-gate,audit-schema,evidence-recorder}.ts` 审计表结构校验逻辑与 `test/audit/promotion-gate.test.ts` 单测。
   - 可选 Stretch 纯前端/API 项：`F21`（Fork Push 确认流 UI）、`F25`（桌面通知）、`F26`（OSV 依赖提示）、`F27`（分享卡片）。

### 2. Owner 负责的 Kiro CLI / Docker 沙箱与上线任务（Owner Scope — Requires Kiro CLI / Docker Sandbox）

1. **Task 18（Checkpoint 18 — 真实沙箱录制与 E11 校准运行）**：在 Linux Docker 宿主机配合 `kiro-cli`（Claude 5.5）再跑通 **2 个不同真实仓库**并固化至 `output/recorded-runs/`（凑齐 3 份录制包），随后运行队友编写的 `scripts/calibrate-e11.ts` 落盘校准结果。
2. **Task 20 / Task 23 / Stretch `F24`/`F28`/`F29` 的真实容器与 `kiro-cli` 联调**：在开发机真实 Docker 容器与 `kiro-cli` 会话下验证多 `Soul-stitcher` 并行、容器 OOM/TTL 重建恢复及容器内 CPython 门禁。
3. **Task 28（28.1/28.3/28.4 真实云沙箱对接）与 Task 29.2–30（上线安全审计与生产环境验证）**：对接 Docker Agentic Platform 云沙箱 SDK 与生产宿主机 `kiro-cli`，执行 `XR-01..XR-03` 实测、G1/G3 安全审计签字、生产凭据轮换与 Checkpoint 30 验收。
4. **`T23` 凭据轮换与仓库公开**（以及与队友协作完成 `T7` 演示视频录制）。
