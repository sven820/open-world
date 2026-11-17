# AI Agent 研发计划（Roadmap）

> 状态：active ｜ 创建：2026-11-17 ｜ 最后更新：2026-11-17
> 策略：一次选型（Mastra），增量启用。每个阶段只引入当下需要的框架能力，用到的概念才学。
> 进度标记：[ ] 未开始 / [~] 进行中 / [x] 完成

---

## 阶段 1：网关最小闭环（目标 1–2 周）

**目标**：AI 调用收口到服务端，Key 出浏览器，前端拿到与现状等价的功能 + 更安全的架构。

- [x] 建立 `ai-gateway/` 服务骨架（Mastra + OpenAI 兼容 provider + 能力注册表）
- [x] 实现 `face-refine` 能力（迁移 aiStylist 的大模型调用逻辑为 Mastra Agent）
- [x] 网关 HTTP 层：`/health`、`/api/ai/abilities`、`/api/ai/:ability/invoke`
- [x] 前端 `walkstreet/src/ai/wsAiClient.js` 统一客户端（网关优先、直连/本地规则回退）
- [x] `aiStylist.js` 接入 wsAiClient（原直连逻辑保留为回退）
- [ ] 配置 `.env` 并实测 DeepSeek/通义端到端（需要 API Key，由使用者执行）
- [ ] 按 `testing/ai-gateway-test-cases.md` 执行验收并回填结果
- [ ] （可选）AI 配置面板增加"网关模式"提示，引导迁移

**完成定义**：断网/无 Key 时前端功能不劣于现状；有 Key 时捏脸全链路走网关；localStorage 中不再需要 apiKey。

## 阶段 1.5：image-avatar 迁移 + 网关加固（目标 1 周）

- [x] `local-dev.ps1` 集成 ai-gateway 启动（start/stop/status 全支持；网关启动失败仅告警不阻塞，2026-11-17 完成并实测）
- [x] `image-avatar` 能力上线（vision 模型路由，base64 ≤7MB 校验；AI 栏支持图片/粘贴/拖入附件，2026-11-17）
- [x] AI 栏支持 GLB 模型附件载入为自定义角色（≤3MB 转 dataURL 持久化，2026-11-17）
- [ ] 验证：配置 `AI_PROVIDER_VISION_MODEL` 后端到端实测以图捏脸（需使用者填 Key）
- [ ] 网关调用日志（能力 ID、耗时、模型、token 用量、finishReason）
- [ ] 每能力成本归属统计（为额度系统铺路）
- [ ] 简单限流：单用户并发上限 + 单日调用上限（先按 IP/客户端 ID）

## 阶段 2：记忆与对话体验（目标 2–3 周）

**目标**：Agent 有了"记住用户"的能力，通用对话能力上线。

- [ ] Mastra Memory 接入（LibSQL 存储起步，thread/resource 模型）
- [ ] 通用 `chat` 能力：流式 SSE + 多轮上下文（供未来各业务对话入口复用）
- [ ] `editor-assist` 能力（编辑器问答/参数建议，消费 chat + 场景上下文）
- [ ] 捏脸偏好记忆：跨会话记住用户审美倾向
- [ ] 简单评测集：face-refine 输出质量回归（记录 20 条中文描述的期望参数集）

## 阶段 3：AI 建模与建场景（随 Model Studio 排期）

**目标**：长任务工作流 + 人工审批落地，对齐"豆包级"体验。

- [ ] 3D 生成服务选型调研（Meshy / Tripo / 混元3D：质量/价格/接口/导出格式）
- [ ] `model-generate` Workflow：提交 → 轮询生成服务 → 减面/转 glTF → 入库预览 → 用户审批 → 入资产库
- [ ] `scene-build` Agent：editor3d 工具封装（摆放/变换/材质）+ vision 自检迭代 + requireApproval
- [ ] 任务进度推送（SSE/轮询）与失败重试
- [ ] 成本控制：生成次数纳入额度体系，结果资产全局复用

## 远期（按需评估）

- [ ] DeepSeek Harness 作为强执行子代理（批处理/改代码任务），等 v1.0
- [ ] Coze Studio 叠加为可视化运营层（产品经理参与编排）
- [ ] 服务端 Java 化时的双栈并存方案（网关协议已保证前端零改动）
- [ ] 多用户多租户（登录、配额、会话隔离完整方案）

---

## 里程碑与验收锚点

| 里程碑 | 判定标准 | 状态 |
|---|---|---|
| M1 网关闭环 | 阶段 1 测试用例全部通过；前端无明文 Key | 待验收 |
| M2 能力平台成型 | ≥3 个能力走统一注册表；调用日志/成本可见 | 未开始 |
| M3 专业 Agent 体验 | 记忆 + 流式对话 + 长任务工作流 + 审批任一场景全通 | 未开始 |
| M4 建模建场景上线 | "文字→资产→摆进场景"全链路可用 | 未开始 |
