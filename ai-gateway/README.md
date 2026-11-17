# ai-gateway —— AI 能力网关（Mastra）

AI 能力统一入口：各子业务不直连大模型，统一走本网关。

## 架构概览

```
HTTP 层 src/index.ts（路由/CORS/错误映射，不掺业务）
   → 能力注册表 src/mastra/abilities/registry.ts（能力 = 纯函数 + 校验）
      → Mastra Agent src/mastra/agent.ts（真正干活，Key 在 .env）
```

设计契约与决策：[`docs/design/ai-agent-gateway-design.md`](../docs/design/ai-agent-gateway-design.md) ｜
[`docs/adr/ADR-0001-ai-agent-framework-selection.md`](../docs/adr/ADR-0001-ai-agent-framework-selection.md)

## 启动

```powershell
npm install
Copy-Item .env.example .env   # 编辑 .env 填入 AI_PROVIDER_API_KEY
npm run dev                   # http://127.0.0.1:8788（改代码自动重启）
npm run typecheck             # TypeScript 类型检查
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（含模型配置状态） |
| GET | `/api/ai/abilities` | 能力清单 |
| POST | `/api/ai/:ability/invoke` | 能力调用，如 `face-refine` |

## 现有能力

- `face-refine`：文本捏脸（入参 `{prompt, currentConfig}`，出参 `{ok, reply, changes, source}`）

## 代码规范（强制）

- Agent `maxSteps=25`；每次 generate 后检查 `finishReason` 与空文本（防静默失败）
- 工具/能力为纯函数；HTTP 层不掺业务
