# AI 网关设计（阶段 1：Mastra 最小闭环）

> 状态：active ｜ 创建：2026-11-17 ｜ 最后更新：2026-11-17
> 上游文档：[ADR-0001 选型 Mastra](../adr/ADR-0001-ai-agent-framework-selection.md) ｜ [需求总表](../requirements/ai-ability-requirements.md) ｜ [Roadmap](../plans/ai-agent-roadmap.md)
> 本文档描述阶段 1 的完整设计与实现约定。**实现与本文档不一致时，以本文档为准或先改本文档。**

---

## 1. 目标与非目标

### 目标（阶段 1）

1. 新建独立 Node 服务 `ai-gateway/`，基于 Mastra 提供"能力（Ability）"调用 API
2. 第一个能力 `face-refine`：迁移捏脸 AI 的大模型调用逻辑到网关
3. 前端统一客户端 `wsAiClient`：网关优先，旧直连/本地规则引擎作回退
4. API Key 收口到服务端环境变量

### 非目标（明确不在阶段 1）

- 鉴权/多租户/限流（阶段 1.5+，仅限本机/内网开发使用）
- 流式对话、Memory、Workflow（阶段 2/3）
- 以图生成迁移（阶段 1.5）

---

## 2. 总体架构

```
浏览器（walkstreet）
│  walkstreet/src/ai/wsAiClient.js     ← 统一客户端，探测+调用+回退
▼
AI 网关（ai-gateway/，Node + Mastra，端口 8788）
│  src/index.ts                        ← HTTP 层：路由/CORS/错误映射（不掺业务）
│  src/mastra/abilities/registry.ts    ← 能力注册表：id → {描述, 校验, 执行}
│  src/mastra/abilities/faceRefine.ts  ← 能力实现（纯函数 + Agent 调用）
│  src/mastra/agent.ts                 ← Mastra Agent（maxSteps=25）
▼
模型厂商（DeepSeek / 通义 / Moonshot / OpenAI 兼容任意端点，Key 在 .env）
```

分层职责铁律：
- **HTTP 层不掺业务**：只做路由、JSON 解析、CORS、错误码映射
- **能力层不掺协议**：能力实现返回业务对象，不知道 HTTP 的存在
- **模型调用只发生在能力层**，经 Agent；新增能力 = 注册表加一项 + （可选）新增 Agent

---

## 3. 目录结构

```
ai-gateway/
├─ package.json         # @mastra/core + @ai-sdk/openai-compatible + zod；tsx 运行 TS
├─ tsconfig.json
├─ .env.example         # 环境变量模板（复制为 .env 后填写）
├─ .gitignore           # node_modules / .env / .data
├─ README.md            # 启动指南
└─ src/
   ├─ index.ts          # HTTP 入口（node:http，端口 AI_GATEWAY_PORT 默认 8788）
   ├─ config.ts         # 环境变量读取与模型 provider 构造
   └─ mastra/
      ├─ index.ts       # new Mastra({ agents })，网关唯一的 Mastra 实例
      ├─ agent.ts       # face-stylist Agent（指令 + 模型 + maxSteps 25）
      └─ abilities/
         ├─ faceParams.ts   # 捏脸参数镜像表（id/label/min/max，与前端 faceParams.js 同步维护）
         ├─ faceRefine.ts   # face-refine 能力（prompt 构建、JSON 解析 = 纯函数）
         └─ registry.ts     # 能力注册表与类型定义
```

前端新增/修改：

```
walkstreet/src/
├─ ai/wsAiClient.js     # 新增：统一客户端（探测/调用，网关地址解析）
└─ creator/aiStylist.js # 修改：refine() 先走网关，失败回退旧路径（直连/本地规则）
```

---

## 4. 能力（Ability）契约

### 4.1 注册表接口

```ts
interface Ability {
  id: string;                          // 全局唯一，如 "face-refine"
  description: string;
  inputHint: Record<string, string>;   // 入参说明（自描述，供 abilities 接口返回）
  validate(payload): string | null;    // 校验入参，返回错误信息或 null
  run(payload, ctx): Promise<unknown>; // ctx = { mastra, agent, config }
}
```

**约束**：
- `run` 返回纯业务对象；HTTP 层统一包成 `{ result }` 返回
- 入参校验必须显式（阶段 1 手写校验；阶段 2 可换 zod schema 统一校验）
- 任何能力内部异常都要转成结构化 `GatewayError{status, code, message}` 抛出，由 HTTP 层映射

### 4.2 face-refine 契约

请求：`POST /api/ai/face-refine/invoke`

```json
{ "prompt": "大眼睛 瓜子脸", "currentConfig": { "avatar": "/avatars/jie.glb", "params": { "eyeSize": 50, "...": 50 } } }
```

响应：

```json
{ "result": { "ok": true, "reply": "已放大眼睛、收窄脸型", "changes": { "eyeSize": 72, "faceWidth": 30 }, "source": "agent" } }
```

规则：
1. `changes` 只含模型声明要修改的参数，且值已被 clamp 到 [0,100]
2. **前端仍用本地 PARAM_MAP 二次 clamp**（前端是参数权威；网关 clamp 是防御性冗余）
3. 模型未返回有效参数时返回 `{ ok:false, reply:"模型未返回有效参数" }`，HTTP 200（业务失败 ≠ 协议失败）
4. 未配置模型 Key → `503 { error:{ code:"MODEL_NOT_CONFIGURED" } }`
5. `source` 取值：`agent`（网关 Mastra Agent）

### 4.3 image-avatar 契约（2026-11-17 新增）

请求：`POST /api/ai/image-avatar/invoke`（请求体上限 8MB）

```json
{ "imageBase64": "…JPEG base64…", "extraPrompt": "更瘦一点", "currentConfig": { "params": { } } }
```

- 前端先用 `prepareImage()`（`imageAvatar.js`）压缩到 768px/JPEG 0.82 再上传
- 由 `image-stylist` Agent（vision 模型 = `AI_PROVIDER_VISION_MODEL`，未配置回退主模型）处理，输出契约与 face-refine 相同（`{ok, reply, changes, source}`）
- 主模型不支持图片时返回 502 `MODEL_ERROR`，前端回退旧直连/本地图像分析
- base64 超 7MB → 400 `INVALID_PAYLOAD`

### 4.4 参数 schema 镜像

### 4.3 参数 schema 镜像

`faceParams.ts` 镜像前端 `walkstreet/src/creator/faceParams.js` 的 **24 个参数**（22 形态 + skinTone/hairColor），仅含 id/label/min/max。**同步维护约定**：前端参数表变更时必须同步本镜像，镜像注释顶部写明来源文件路径。前端永远以本地表做最终 clamp，因此即使镜像短暂漂移也不会产生非法数据。

---

## 5. API 规格

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ ok:true, model:{ configured, baseURL, model } }`（Key 不回显） |
| GET | `/api/ai/abilities` | 能力清单 `[{ id, description, inputHint }]` |
| POST | `/api/ai/:ability/invoke` | 能力调用，body 为 JSON，响应 `{ result }`；图片类能力请求体上限 8MB |

错误格式统一：`{ "error": { "code": "...", "message": "..." } }`

| 状态码 | code | 场景 |
|---|---|---|
| 400 | INVALID_PAYLOAD | 入参缺失/类型错误（message 指明字段） |
| 404 | ABILITY_NOT_FOUND | 能力 ID 不存在 |
| 503 | MODEL_NOT_CONFIGURED | 服务端未配置模型 Key |
| 500 | INTERNAL | 能力执行异常（message 含摘要，服务端打印堆栈） |

CORS：阶段 1 放开 `*`（仅限本地开发；公网部署前必须改为白名单，见 Roadmap 阶段 1.5）。

---

## 6. 模型接入

- 阶段 1 使用**单 provider**（OpenAI 兼容协议），环境变量：

```
AI_GATEWAY_PORT=8788
AI_PROVIDER_BASE_URL=https://api.deepseek.com/v1
AI_PROVIDER_API_KEY=sk-xxx
AI_PROVIDER_MODEL=deepseek-chat
AI_PROVIDER_VISION_MODEL=        # 可选，image-avatar 用的视觉模型（如 qwen-vl-max）
```

- 用 `@ai-sdk/openai-compatible` 构造，天然兼容 DeepSeek/通义/Moonshot/本地 vLLM，与前端 `aiConfig.js` 的预设列表同源
- 阶段 1 不实现响应格式 `response_format`，靠 system prompt 约束 JSON 输出 + 宽容解析（剥离 ```json 围栏、截取首尾大括号），与现有前端解析策略一致
- **多模型路由留待阶段 2**：届时 provider 构造改为按能力声明选择模型

---

## 7. Mastra 使用规范（本仓库强制）

1. `maxSteps` 一律显式设为 **25**（框架默认 5 步会静默返回空文本，实测确认的坑）
2. 每次 `agent.generate(...)` 后**必须检查**返回值：`text` 为空或 `finishReason` 异常（`length`/`error`）时按业务失败处理，不得返回空成功
3. Agent 指令（system prompt）与业务参数 schema 分离：指令管行为规则，schema 由 `faceParams.ts` 生成注入
4. 新增 Agent 一律注册进 `mastra/index.ts` 的 `Mastra({ agents })` 实例，禁止散落裸建

---

## 8. 前端接入设计（wsAiClient.js）

### 网关地址解析优先级

`URL 参数 ?ai=<url>` > `localStorage["ws_ai_gateway_url"]` > 默认 `http://127.0.0.1:8788`；`?ai=off` 强制禁用网关（直接走回退，便于排障）。

### 探测与调用

- `gatewayAvailable(timeout=1500)`：GET `/health`，结果缓存 30 秒（避免每次捏脸都探测）
- `invokeAbility(ability, payload)`：POST invoke，非 2xx 抛出带 `code` 的 Error
- **调用失败永不阻塞业务**：`aiStylist.refine()` 捕获一切网关异常后回退旧路径（直连 → 本地规则引擎），回退提示沿用现有文案

### 回退链

```
网关可用 → invoke face-refine（前端二次 clamp）
   ↓ 失败/不可用/无效结果
旧直连大模型（用户此前自行配置了 Key 时）
   ↓ 失败/未配置
本地规则引擎 localRefine（永远兜底）
```

> 阶段 1 保留旧直连路径是为了平滑过渡；阶段 1.5 验收"网关 + 服务端 Key"稳定后，前端配置面板改为只读展示网关状态，直连路径降为"高级模式"。

---

## 9. 阶段演进预留

| 演进点 | 预留方式 |
|---|---|
| Memory（阶段 2） | Mastra Memory 以 threadId 为粒度；invoke 协议预留可选 `threadId` 字段（阶段 1 忽略） |
| 流式（阶段 2） | HTTP 层预留 `/api/ai/:ability/stream`（SSE）路径规范，与 invoke 同一套能力层 |
| Workflow（阶段 3） | registry 的 `run` 返回值允许 `{ kind:"job", jobId }`，HTTP 层增加任务查询路由即可，能力契约不变 |
| 换框架/换语言 | 对外协议保持 OpenAI 兼容 + 能力化 REST；工具为纯函数；前端 `wsAiClient` 不感知框架 |
| 多进程部署 | HTTP 层无状态；阶段 2 引入存储后接 LibSQL/Postgres，PM2 `-i max` 即可横向扩 |

---

## 10. 测试与验收

见 [testing/ai-gateway-test-cases.md](../testing/ai-gateway-test-cases.md)（TC-01 ~ TC-12）。实现完成后逐条执行并回填结果。
