# AI Agent 架构调研与设计思考

> 状态：active ｜ 创建：2026-11-17 ｜ 最后更新：2026-11-17
> 本文档是系统 AI 能力升级（会话 → Agent 平台）的调研与选型思考记录。
> 数据（框架热度、版本、实测结论）以调研当日为准，决策前建议复核最新版本状态。
> 选型决策见 [ADR-0001](../adr/ADR-0001-ai-agent-framework-selection.md)，实施设计见 [ai-agent-gateway-design.md](../design/ai-agent-gateway-design.md)。

---

## 1. 背景与目标

系统当前的 AI 能力仅限于捏脸工坊的单轮对话（文本捏脸 + 以图生成），远未形成 Agent 能力。本次升级目标：

1. **对标专业 AI Agent 产品**（豆包 / Workbuddy 级体验）：工具调用、流式输出、多轮记忆、工作流、人工审批、可观测评测
2. **能力平台化**：把 AI 能力封装成统一服务，供系统各子业务（捏脸、以图生成、3D 编辑器、广告牌、未来的 AI 建模/建场景）调用
3. **技术栈约束**：Web 技术栈（TS/Node 优先）；服务端未来可能换 Java，需保留架构退路
4. **开发者现实**：单人独立开发 + AI 辅助编程，选型必须考虑学习成本与长期维护负担

---

## 2. 现状盘点（调研实锤）

### 2.1 前端 AI 会话（walkstreet）

| 问题 | 现状位置 |
|---|---|
| 单点能力、非 Agent | `walkstreet/src/creator/aiStylist.js`：单轮 prompt + 一次 `/chat/completions` 调用，失败退化为关键词规则引擎（`localRefine`） |
| Key 前端明文暴露 | `walkstreet/src/config/aiConfig.js`：apiKey 存 localStorage，浏览器直连模型厂商，任何用户可盗用 |
| 无统一能力层 | 捏脸、以图生成（`src/creator/imageAvatar.js`）各自直连，无工具注册/分发机制 |
| 无体验与治理 | 无流式、无记忆、无观测、无评测 |

### 2.2 服务端（admin）

- `admin/server.js`（约 590 行）：**零 npm 依赖**的 Node 原生 `http` 单文件服务，端口 8787，监听 127.0.0.1
- 15 个 REST 端点，全部服务于广告牌业务（屏位/素材/节目单/发布快照），**无 AI 相关代理**
- 无鉴权、CORS 全开 `*`、无数据库（JSON 文件 `data/state.json` 原子写持久化）
- 前端通过 `walkstreet/src/world/billboard/adminClient.js` 轮询接入

**判断**：admin 不具备承载 Agent 能力的条件，但升级路径清晰——规划中的"复杂服务端"正是引入 Agent 层的契机。

---

## 3. 候选方案对比结论

### 3.1 代码型 TS Agent 框架（主网关候选）

| 维度 | Vercel AI SDK | **Mastra（选定）** | LangGraph.js |
|---|---|---|---|
| 定位 | 流式 UI + 工具循环库（非完整框架） | TS 全功能 Agent 框架 | 图编排引擎 |
| 安装体积 | 29 MB / 12 包（最轻） | 158–202 MB / 149–185 包（最重） | 115 MB |
| npm 周下载 | ~1976 万 | ~144 万 | ~233 万 |
| GitHub Stars | 2.7 万 | 2.9 万 | 0.34 万（JS 版弱于 Python 版） |
| 记忆持久化 | 无内置（自建，工具历史会丢） | 内置 Memory + 存储，完整保留 | 内置 checkpointer |
| 工作流/审批 | 无 / 需自建 | 内置 Workflows + requireApproval | 图编排最强 |
| 已知坑 | 650 版/年跟进成本 | **默认 maxSteps=5 且超限静默返回空文本**（必须调高 + 检查 finishReason）；安装重 | MemorySaver 重启静默丢状态（生产必须换 DB saver） |
| 与 AI SDK 关系 | — | **底层直接依赖 AI SDK**（升级而非替换） | 独立生态 |

数据来源：AgentStack 2026-10 同任务实测（正常任务/失控循环/两轮记忆/人工审批/跨进程重启五场景）。

### 3.2 平台型方案（备选/后置）

| | Coze Studio 开源版 | Dify |
|---|---|---|
| 出身 | 字节扣子同源（豆包理念），Apache 2.0，21.8k 星 | 社区标杆，6.5 万+ 星 |
| 技术栈 | Go(Hertz) + React/TS + FlowGram + Eino | Python 栈为主 |
| 能力 | 可视化工作流、插件框架、知识库、记忆、OpenAPI+Chat SDK | RAG/知识库最强、企业级监控 |
| 部署 | Docker Compose，最低 2C4G | Docker，稍重 |
| 不选为主力的原因 | 多一套 Go 微服务要维护；深度定制要动 Go | 对"游戏化 3D 业务工具封装"场景不如 Coze 贴合 |

**定位**：平台型可作为未来的可视化运营层叠加，与代码型主网关不冲突。

### 3.3 DeepSeek Harness（DSH）评估

**定位**：Agent 运行时（"Model + Harness = Agent"），对标 Claude Code/Codex，**不是**编排框架。基于 Cordis 插件内核（Koishi 同源），"一切皆插件"。MIT 开源，27.8 万星（2026-11），最新 v0.2.x。

| 适合 | 不适合 |
|---|---|
| 强执行任务：改代码、批处理、终端自动化 | 结构化 API 工具调用（沙箱/终端能力用不上且引攻击面） |
| TS/Node 技术栈嵌入（TS SDK / headless 模式） | 直接当唯一底座：Developer Preview 有破坏性变更；仓库禁用 issues/PR；无 API-first 服务模式；Windows 安装坑多 |

**结论**：不作为主底座。未来可作为"强执行子代理"由网关调度（headless / TS SDK），或等 v1.0 后重评。

---

## 4. 最终选型决策

### 4.1 决策记录

**主网关框架：Mastra，分三阶段增量启用。**（决策细节见 ADR-0001）

### 4.2 分阶段启用计划

| 阶段 | 时间 | 启用能力 | 内容 |
|---|---|---|---|
| 阶段 1 | 第 1–2 周 | 仅 Agent + Tool | 脚手架起项目；捏脸工具 + 流式 + Key 托管网关；**代码规范写死：maxSteps 调至 25 + 每次检查 finishReason** |
| 阶段 2 | 第 3–6 周 | Memory + 存储 | LibSQL 起步（零运维）；捏脸偏好记忆、跨会话上下文 |
| 阶段 3 | AI 建模功能启动时 | Workflow + requireApproval | 3D 生成长任务后台化（Meshy/Tripo API 分钟级任务，进度可查、失败重试）；场景改动走审批卡片 |

### 4.3 架构接缝原则（保退路）

无论框架如何演进，守住三条：

1. **工具写成纯函数**（输入→输出，不绑框架调用方式），Mastra/AI SDK/未来框架通吃
2. **网关对前端暴露 OpenAI 兼容协议**（`/v1/chat/completions` + SSE），前端 `ws-ai-client` 只认协议不认框架——后端换 Mastra/Java/平台型，前端零改动
3. **工具封装优先考虑 MCP 协议**，换框架时工具层可迁移

---

## 5. 目标架构

```
┌─ 前端（walkstreet 各子业务）──────────────────────────┐
│  统一 ws-ai-client：call('ability', payload) / stream()          │
│  捏脸 | 以图生成 | 3D编辑器助手 | 广告牌文案 | AI建模/建场景      │
└──────────────┬───────────────────────────────────┘
┌─ AI 网关（独立 Node 服务，与 admin 并存）──────────────┐
│  ① 网关层：鉴权、额度/计费、限流排队、多模型路由、OpenAI 兼容 API │
│  ② Agent 运行时（Mastra）：Agent/工具/记忆/工作流/审批           │
│  ③ 业务工具注册表：捏脸参数、以图生成、billboard API、            │
│     editor3d/studio 操作、3D 生成服务（Meshy/Tripo/混元3D）       │
│  ④ 观测评测：Mastra evals / Langfuse                             │
│  （可选）强执行子代理：DeepSeek Harness headless，跑改代码/批处理  │
└─────────────────────────────────────────────────┘
```

- admin（广告牌业务）与 AI 网关**独立进程**，互不拖累；未来 Java 化时只迁移一边
- AI 建模链路：生成服务（分钟级）→ Workflow 后台任务 → 减面/转 glTF → 入资产库（studio）→ Agent 调编辑器工具摆场景 → 截图 vision 自检 → 用户审批 → 写入世界数据

---

## 6. 多用户与部署要点

### 6.1 并发模型认知

- Node 执行业务代码单线程，但 IO 多路复用；AI 网关负载画像 = **海量等待（等模型回话）+ 少量计算**，正是 Node 甜点区
- 多核利用靠**多进程部署**；CPU 密集任务丢 Worker Threads；单机起步完全够用，瓶颈通常先是 token 账单而非服务器

### 6.2 部署清单（单机起步）

```bash
# Ubuntu 22.04 / 24.04（glibc ≥ 2.28；CentOS 7 不支持）
# Node 22.19+ 或 24
npm install -g pm2
pm2 start gateway.js -i 4 --name ai-gateway   # 多进程，自动守护/0停机重启
pm2 save && pm2 startup                        # 开机自启
# Nginx 反代 + HTTPS；会话状态外置（Redis/DB），进程保持无状态
```

- 框架（Mastra/AI SDK）**不自动多进程**，扩容是运维层的事；用 Mastra 必须配置存储适配器（否则多进程状态分裂）
- 水平扩容前提：进程无状态 + 会话外置；人多了加机器线性扩展

### 6.3 多用户治理（从第一天就要有）

1. **额度/计费系统**：token 与 3D 生成 API 都是真实成本，先于功能上线
2. **排队限流**：每用户并发会话上限，防止单用户打爆资源
3. **Key 全部服务端托管**：废除浏览器 localStorage 存 Key 的现状
4. **会话隔离**：多用户共享运行时时，每用户独立会话与工作区；涉及文件系统执行（DSH）时严格目录白名单 + 受限账号

---

## 7. 风险清单与对策

| 风险 | 对策 |
|---|---|
| Mastra maxSteps=5 静默失败（实测确认） | maxSteps 调 25 + 每次调用检查 finishReason，写入代码规范 |
| Mastra 迭代快、API 变动 | 锁定 minor 版本升级；接缝原则保迁移退路 |
| 3D 生成 API 成本（Meshy/Tripo 按次收费） | 走网关额度体系；生成结果入库复用 |
| DSH Developer Preview（v0.x 破坏性变更、无 PR 通道） | 不作主底座；仅 headless 子代理形态，等 v1.0 重评 |
| 平台型（Coze Studio）公网部署安全项（SSRF/越权） | 若引入，置于内网 + 反代认证之后 |
| 前端现状：Key 明文 localStorage、无鉴权 | 阶段 1 即收口到网关；admin CORS/鉴权随服务端重构一并治理 |

---

## 8. 待办（按优先级）

- [ ] 阶段 1：Mastra POC——捏脸能力迁移到网关（工具 = 纯函数）
- [ ] 前端 `ws-ai-client` 封装（OpenAI 兼容协议 + SSE），替换 `aiStylist.js` 直连
- [ ] Key 服务端托管，废弃 localStorage 配置面板
- [ ] admin 与 AI 网关的进程拆分方案（PM2 双应用或独立目录）
- [ ] 额度/计费模型设计（token + 3D 生成按次）
- [ ] AI 建模服务选型调研（Meshy / Tripo / 混元3D 对比，未做）
- [ ] （远期）DSH 子代理集成评估、Coze Studio 可视化运营层评估

---

## 9. 本轮关键问答备忘（决策依据沉淀）

- **Q：先 AI SDK 后升 Mastra 可行吗？** 可行（Mastra 依赖 AI SDK，是"加层"不是"换框架"），但路线图含建模建场景 → 直接 Mastra 一次到位
- **Q：为什么 AI SDK 不够？** 无记忆/工作流/评测/审批内置；AI 建模的分钟级长任务需要持久化工作流
- **Q：Node 单线程会不会瓶颈？** 业务代码单线程但 IO 多路复用；AI 网关 IO 密集，多进程部署吃满多核；真瓶颈通常是上游模型 API 与 token 成本
- **Q：Mastra/AI SDK 自带多进程吗？** 不带，它们是库；多进程是部署层（PM2/cluster/K8s）的事；Mastra 必须配存储适配器防多进程状态分裂
- **Q：后端未来换 Java 怎么办？** 三路线：Node AI 网关与 Java 并存（微服务，最常见）；换 Spring AI/LangChain4j；守住 OpenAI 兼容协议接缝，进可攻退可守
- **Q：DSH 能否做多用户 AI 应用？** 官方无多租户服务模式；个人用 `npm i -g @deepseek-ai/dsh` + `dsh web` 即可；多用户需自建网关（或参考社区插件 dsh-passwords/dsh-multi-tenant，但属"软边界"，公网不可依赖）

---

## 参考

- AgentStack 实测：Mastra vs Vercel AI SDK vs LangGraph.js（agentopsguide.com，2026-10）
- Mastra 官方：mastra.ai（1.0 公告、Composite storage）
- DeepSeek Harness：github.com/deepseek-ai/deepseek-harness（MIT）；第三方评测 deepseekai.works
- Coze Studio：github.com/coze-dev/coze-studio（Apache 2.0）
- Dify / n8n / Langflow 横评（2026 各技术媒体）
