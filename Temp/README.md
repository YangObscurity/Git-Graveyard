# Temp/ — 可复用脚本（入库）

> 一次性草稿不进这里；草稿放 `.agent-ws/<task-id>/`。

| 约定 | 说明 |
|---|---|
| 命名 | `kebab-case.py` / `kebab-case.ps1`，一个脚本一件事 |
| 头部 | 写清用途、输入、输出、运行示例 |
| 幂等 | 重跑不产生重复副作用 |
| 依赖 | 只用本机已有工具（python / node / npx / git / pandoc），重工具链派发 |