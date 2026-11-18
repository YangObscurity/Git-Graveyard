# Git-Graveyard: Official Hackathon & Technical References
# 网页依据与官方赛事/技术参考文档

## 1. Kiroween 2026 官方赛事依据

* **赛事主页**: [Kiroween 2026 on Devpost](https://kiroween.devpost.com/)
* **官方规则 (Rules)**: [Kiroween 2026 Rules](https://kiroween.devpost.com/rules)
  * **赛道定义**:
    * **Resurrection (本项目选定赛道)**: *Bring your favorite dead technology back to life. Reimagine obsolete tech with today's innovations or apply it to solve tomorrow's problems.* (让已死亡的技术重获新生，用现代技术重新构想过时技术，或用其解决未来的问题)。
    * **Frankenstein**: *Stitch together a chimera of technologies into one app. Bring together seemingly incompatible elements to build something unexpectedly powerful.*
    * **Skeleton Crew**: *Build a skeleton code template lean enough to be clear, yet flexible enough to support various use cases. Build two distinct applications from your foundation.*
    * **Costume Contest**: *Build any app, but feature a haunting user interface that is polished and unforgettable.*
  * **硬性提交要求**:
    1. 必须是公开 GitHub 仓库，根目录下必须包含 `/.kiro` 目录（包含 steering docs、specs 或 agent hooks）。
    2. 必须包含开源许可证（Open Source License）。
    3. 项目构建时间必须在比赛周期内（2026年10月30日 - 2026年12月4日）。
    4. 提交物必须包含 2~3 分钟的演示视频（Video Demo）与可运行的真实应用。
* **资源中心与额度申请 (Resources)**: [Kiroween 2026 Resources](https://kiroween.devpost.com/resources)
  * **Kiro Credits**: 提供 4,000 点 Kiro AI Coding Credits（约价值 $160），截止申请时间为 2026年12月1日 12:00 PM PT。

---

## 2. Kiroween 2025 官方获奖作品深度复盘 (Benchmarking)

* **2025 官方展厅**: [Kiroween 2025 Project Gallery](https://kiro.devpost.com/project-gallery)
* **往届标杆作品启示**:
  1. **《ELIZA EXHUMED》（Resurrection 赛道冠军）**:
     * **核心做法**: 将 1966 年世界上第一个心理学聊天机器人 ELIZA“起死回生”，置入复古发光的 CRT 绿光终端中。
     * **万圣节灵魂机制**: 设计了“恶灵附身模式 (Spectral Mode)”，现代大模型（Amazon Nova）寄生在旧程序内，但必须受制于 1966 年的原始规则。
     * **给我们的启示**: 评委极度青睐“技术史经典 + 幽灵/复活仪式感 + 现代大模型”的三位一体结合。
  2. **《Zombie Blaster》（官方大奖）**:
     * **核心做法**: 解决枯燥的 AWS 云账户“僵尸权限/IAM 秘钥泄漏”清理，包装成 8-bit 复古打僵尸游戏。
     * **给我们的启示**: 严肃的清理/回收工作流，通过游戏化和万圣节题材包装，极易引发现场轰动。
  3. **《Dark Ledger》（Frankenstein 赛道代表）**:
     * **核心做法**: 缝合 60 年前老古董 COBOL 薪酬计算逻辑与现代 Base 区块链链上清算。

---

## 3. Kiro IDE 技术核心机制与集成规范

* **官方技术文档**: [Kiro AI Documentation](https://kiro.dev/docs)
* **Kiro 核心四大支柱与落地规范**:
  1. **Spec-Driven Development (`.kiro/specs/`)**:
     * Kiro 摒弃了毫无章法的盲目 prompt 编程，推崇三阶段规范驱动：
       * `requirements.md`: 需求与验收标准（EARS 规范）。
       * `design.md`: 架构变迁、数据流与替代方案设计。
       * `tasks.md`: 可追踪、原子化的分步执行任务清单。
     * *Git-Graveyard 集成方式*: 对死亡仓库进行分析后，动态生成该仓库现代化的标准 Spec 规范三件套。
  2. **Steering Docs (`.kiro/steering/*.md`)**:
     * 持久化架构与工程上下文（包含 `Always` / `File Match` / `Manual` 三种模式）。
     * *Git-Graveyard 集成方式*: 在项目仓库中提供 `resurrection-guidelines.md`，定义依赖替代字典（如 `request` -> `httpx`, `python 2 print` -> `python 3 print()`, `webpack 2` -> `vite`）。
  3. **Agent Hooks (`.kiro/hooks/*.json`)**:
     * 基于事件驱动的自动化触发器（如 `PostFileSave`, `PreToolExecution`）。
     * *Git-Graveyard 集成方式*: 在复活代码生成后，自动触发静态检查、语法树校验与依赖安全审计。

---

## 4. 依赖解析与死因检测参考依据

* **GitHub REST API**:
  * Repo 元数据接口: `GET https://api.github.com/repos/{owner}/{repo}`（获取 `pushed_at`, `stargazers_count`, `archived`, `open_issues` 等）。
  * 源码树与依赖文件获取: `GET https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{package.json|requirements.txt}`。
* **弃用生态死因特征库 (Deprecation Signatures)**:
  * **Python 废弃标志**: `python_requires < "3.0"`, `distutils` 依赖, `imp` 模块使用, `urllib2`, `thread` 模块。
  * **Node/JS 废弃标志**: `webpack < 4`, `node-sass`, `gulp`, `babel-core < 7`, `request` 库（2020年完全废弃）。
