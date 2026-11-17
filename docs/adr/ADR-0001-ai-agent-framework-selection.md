# ADR-0001：AI Agent 框架选型 Mastra

- 状态：accepted
- 日期：2026-11-17
- 决策人：项目所有者
- 关联文档：[ai-agent-architecture-research.md](../architecture/ai-agent-architecture-research.md)

## 背景

系统 AI 会话（捏脸 AI 等）为前端直连大模型的单轮调用，需升级为专业 Agent 能力平台并供各子业务复用。候选：Vercel AI SDK、Mastra、LangGraph.js、Coze Studio、Dify、DeepSeek Harness（评估结论见调研文档）。

## 决策

选定 **Mastra** 作为 AI 网关主框架，按"一次选型、增量启用"分三阶段接入：

1. 阶段 1：仅用 Agent + Tool（等价于 AI SDK 的复杂度）
2. 阶段 2：启用 Memory + 存储适配器（LibSQL 起步）
3. 阶段 3（AI 建模/建场景启动时）：启用 Workflow + requireApproval

## 理由

1. **路线图判定**：AI 建模/建场景需要长任务工作流（3D 生成分钟级任务）、人工审批、跨会话记忆——全部是 Mastra 核心区；用 AI SDK 意味着这些需手搓并长期自维护，独立开发者的最大长期成本恰是自建胶水代码的维护
2. **升级而非替换**：Mastra 底层直接依赖 Vercel AI SDK，工具定义、provider 配置、流式输出可直接复用，一次选型只学一次
3. **AI 编程友好**：官方脚手架 + 本地 Playground 可视化调试；概念模式固定，AI 生成代码一致性高
4. **保留退路**：工具写成纯函数、网关对外暴露 OpenAI 兼容协议，未来换 Java（Spring AI）或叠加平台型方案（Coze Studio）前端与工具层零改动

## 备选方案（否决理由）

| 备选 | 优点 | 缺点 | 否决理由 |
|---|---|---|---|
| 先 Vercel AI SDK、后升 Mastra | 最轻（29MB/12 包）、起步最快；AI SDK 是 Mastra 底层依赖，升级近乎"加层"而非替换 | 记忆/工作流/审批/评测全部要自建并长期维护；路线图（AI 建模/建场景）很快触发这些需求 | 作为过渡可行，但独立开发者"只学一次框架"的价值高于前期轻量；最终仍选 Mastra 一步到位 |
| LangGraph.js | 图编排最强、断点续跑、失败可见（抛 GraphRecursionError） | JS 版生态弱（0.34 万星，远弱于 Python 版）、双包安装、文档坑多 | 编排能力超出当前需求；生态弱对独立开发不友好 |
| Coze Studio 开源版 | 豆包同源理念、可视化编排、少写代码、中文生态 | 多一套 Go 微服务要维护；业务工具须走其插件规范；官方提示公网部署有 SSRF/越权等安全评估项 | 深度定制成本高；定位为未来可视化运营层的叠加选项，不作主底座 |
| Dify | 企业级最成熟（6.5 万+ 星）、RAG/知识库最强 | Python 栈为主，深度定制成本高 | 对"游戏化 3D 业务工具封装"场景不如 Coze 贴合 |
| DeepSeek Harness（DSH） | TS 同源、"一切皆插件"理念契合能力封装、热度极高（27.8 万星）、headless/SDK 可嵌入 | Developer Preview（v0.x 有破坏性变更）、仓库禁用 issues/PR、无 API-first 服务模式、强执行定位（文件/终端）与结构化 API 工具场景错位 | 不作主底座；未来以 headless 强执行子代理形态接入，等 v1.0 后重评 |

## 后果

- 正面：记忆/工作流/评测/审批开箱即用；可视化调试台弥补单人开发无评审短板
- 负面：安装体积大（158MB+）；必须遵守两条代码规范：`maxSteps` 调至 25、每次调用检查 `finishReason`（规避实测确认的静默失败默认值）
- 深度执行类任务（改代码/批处理）将来由 DeepSeek Harness 以 headless 子代理形态接入，不作主底座（DSH 仍处 Developer Preview，v0.x 有破坏性变更）
