## 改动说明
<!-- 简述做了什么、解决了什么问题；可注明关联任务（如 T35 / T37 / T38 / T40） -->

## 影响范围
- [ ] 前端页面 / UI（`app/`、`components/`、`lib/ui/`）
- [ ] 后端引擎 / API（`lib/`、`app/api/`）
- [ ] 测试 / 文档 / CI（`test/`、`output/`、`.github/`）

## 自测清单
- [ ] `./node_modules/.bin/tsc --noEmit` 通过
- [ ] 本地相关测试或 CI 全量检查通过
- [ ] `npm run build` 通过（或由 CI 跑通）
- [ ] 如有 UI 改动，已在本地或 `/debug/ui?uiDebug=1` 确认并附截图
- [ ] 确认未带入 `.agent-ws/`、`memory/`、`01_evidence/`、本机路径、SSH 地址或真实 Token/Key
