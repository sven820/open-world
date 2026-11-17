# AGENTS.md —— AI 编码助手项目规则

> 本文件是给 AI 编码助手（CodeBuddy/Claude Code/Cursor 等）看的项目约定。
> **没写在这里的约束等于不存在**；修改任何约定请同步更新本文件并回 `docs/README.md` 登记。

## 项目一句话

浏览器端 3D 开放世界（three.js + Cesium，原生 JS + Vite）+ 广告牌管理服务端（admin）+ AI 能力网关（ai-gateway，Mastra）。

## 子模块地图

```
├─ walkstreet/    # 主项目：3D 开放世界、捏脸工坊、3D 编辑器、广告牌（Vite + 原生 JS ESM，无框架）
├─ admin/         # 广告牌业务服务端（Node 原生 http 单文件，零依赖，8787）
├─ ai-gateway/    # AI 能力网关（TypeScript + Mastra，8788）
├─ rea/           # 逆向工作区（只读参考资料，不要修改）
└─ docs/          # 文档中枢（architecture/design/requirements/plans/testing/adr）
```

## 文档规矩（先于一切）

1. **文档即真相**：实现与 `docs/design/` 冲突时，先改文档再改代码
2. 重大技术取舍（选型/协议/架构变更）必须在 `docs/adr/` 写一篇 ADR（编号延续、**只增不改**，推翻决策写新篇标记旧篇 deprecated）
3. 新增/移动任何文档，回 `docs/README.md` 索引登记
4. 给 AI 助手下任务时，把对应 requirements + design 文档作为上下文输入

## ai-gateway 代码红线

1. Agent 的 `maxSteps` 必须显式设 **25**（放 `defaultOptions`，框架默认 5 步会**静默返回空文本**——实测确认的坑，Mastra 1.83）
2. 每次 `agent.generate()` 后**必须检查** `finishReason` 与空文本，禁止静默空成功
3. 能力（Ability）实现 = 纯函数 + 显式入参校验；HTTP 层（`src/index.ts`）不掺业务，能力层不掺协议
4. 新能力：`src/mastra/abilities/` 加文件 + 注册进 `registry.ts` 的 `ABILITIES`；新 Agent 必须注册进 `mastra/index.ts` 的 `Mastra({ agents })`，禁止散落裸建
5. 捏脸参数表镜像：改 `walkstreet/src/creator/faceParams.js` 参数时必须同步 `ai-gateway/src/mastra/faceParams.ts`；**前端本地 clamp 是参数权威**

## 架构接缝原则（保退路，不许破坏）

- 前端只认 **OpenAI 兼容协议 + 能力化 REST**（`wsAiClient.js`），不感知网关框架——未来换 Java/平台型方案前端零改动
- AI 调用失败**永不阻塞业务**：回退链 = 网关 → 旧直连 → 本地规则引擎
- API Key 只存在于服务端 `.env`，禁止写回前端/localStorage

## 常用命令

```powershell
start.bat                          # 一键起全套（admin 8787 + walkstreet）
cd ai-gateway; npm run dev         # AI 网关（8788），npx tsc --noEmit 做类型检查
cd walkstreet; npm run dev         # 前端单独开发
# 前端 URL 加 ?ai=off 可强制绕过网关（排障用）
```

## 已知坑

- Mastra 迭代快：依赖锁定 1.x，升级后先跑 `npm run typecheck`；API 对不上时先怀疑版本差异（如 `maxSteps` 已从构造参数移入 `defaultOptions`）
- DeepSeek Harness（若引入）仍处 Developer Preview，禁止作为主依赖
- `docs/` 里的热度/版本数据标注了调研日期（2026-11-17），引用前注意时效
