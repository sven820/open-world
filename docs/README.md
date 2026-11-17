# open-world 项目文档体系

> 本目录是项目**唯一的文档中枢**。所有架构决策、研发设计、需求分析、开发计划、测试用例都归类于此。
> 各子模块（walkstreet / admin）的模块级文档保留在模块目录内，由本索引统一收录。

---

## 一、目录规范

```
docs/
├─ README.md            # 本文件：文档体系总纲 + 全局索引（改动文档必须回此登记）
├─ architecture/        # 架构文档：系统全景、调研报告、架构图
├─ design/              # 研发设计：模块详细设计（怎么做）
├─ requirements/        # 需求分析：做什么、为什么做、验收标准
├─ plans/               # 研发计划：里程碑、阶段任务、进度跟踪
├─ testing/             # 测试用例与执行记录
└─ adr/                 # 架构决策记录（ADR）：每个重大技术决策一篇，只增不改
```

### 文档规范

| 规范 | 说明 |
|---|---|
| 命名 | 小写中划线：`ai-agent-gateway-design.md`；ADR 用 `ADR-000N-短标题.md` |
| 头部 | 每篇文档首行注明：状态（draft/active/deprecated）、创建日期、最后更新日期 |
| ADR | 只增不改：决策推翻时新写一篇并标记旧篇 deprecated，保留决策脉络 |
| 登记 | 新增/移动任何文档，必须同步更新本文件索引表 |
| 归档 | 已废弃文档移入 `docs/archive/`（保留内容，索引中标注） |

---

## 二、全局索引

### architecture/（架构）

| 文档 | 状态 | 说明 |
|---|---|---|
| [ai-agent-architecture-research.md](architecture/ai-agent-architecture-research.md) | active | AI Agent 升级全量调研：框架对比、DSH 评估、选型决策、部署要点、风险清单（2026-11-17） |

### adr/（架构决策记录）

| 文档 | 状态 | 决策 |
|---|---|---|
| [ADR-0001 AI Agent 框架选型 Mastra](adr/ADR-0001-ai-agent-framework-selection.md) | accepted | 主网关选定 Mastra，分三阶段增量启用 |
| [ADR-0002 建立项目文档体系](adr/ADR-0002-docs-system.md) | accepted | 建立 docs/ 中枢 + ADR 机制，文档随代码一起提交 |

### design/（研发设计）

| 文档 | 状态 | 说明 |
|---|---|---|
| [ai-agent-gateway-design.md](design/ai-agent-gateway-design.md) | active | **AI 网关总设计**（阶段 1 实施）：Mastra 集成、能力注册表、协议、目录结构、前端接入 |

### requirements/（需求分析）

| 文档 | 状态 | 说明 |
|---|---|---|
| [ai-ability-requirements.md](requirements/ai-ability-requirements.md) | active | AI 能力需求总表：已上线/在建/规划的能力清单与验收标准 |

### plans/（研发计划）

| 文档 | 状态 | 说明 |
|---|---|---|
| [ai-agent-roadmap.md](plans/ai-agent-roadmap.md) | active | AI Agent 三阶段研发计划 + 当前进度跟踪 |

### testing/（测试）

| 文档 | 状态 | 说明 |
|---|---|---|
| [ai-gateway-test-cases.md](testing/ai-gateway-test-cases.md) | active | AI 网关阶段 1 验收测试用例（含可执行命令） |

### 模块级文档（保留在模块目录，此处收录索引）

| 文档 | 位置 | 说明 |
|---|---|---|
| [AGENTS.md](../AGENTS.md) | 仓库根目录 | **AI 编码助手项目规则**（文档规矩、代码红线、接缝原则、已知坑） |
|---|---|---|
| README.md | `walkstreet/README.md` | walkstreet 模块入口说明 |
| [model-studio-design.md](../walkstreet/docs/model-studio-design.md) | `walkstreet/docs/` | 模型资产编辑器（Model Studio）设计方案 |
| [3d-model-and-materials.md](../walkstreet/docs/3d-model-and-materials.md) | `walkstreet/docs/` | 三维模型与材质扫盲（新人上手） |
| README.md | `admin/` | admin 服务端说明（若无则补充） |

---

## 三、工作流约定

1. **开工前**：先看 `plans/` 确认当前阶段任务 → 需求模糊先补 `requirements/`
2. **做设计**：方案写入 `design/`；重大技术取舍（选型/协议/架构变更）**必须**在 `adr/` 留一篇决策记录
3. **写代码**：实现必须与 `design/` 一致；偏离时先改文档再改代码（文档即真相）
4. **做测试**：用例登记在 `testing/`，执行结果（通过/失败/日期）回填用例表
5. **AI 编程协作**：给 AI 编码助手下任务时，把对应的 requirements + design 文档作为上下文输入，产出与文档对齐
