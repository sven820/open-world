# 频道聊天面板（右下角）设计

> 状态：active · 创建：2026-11-18 · 最后更新：2026-11-18（新增模型选择器）
> 关联：docs/design/ai-agent-gateway-design.md（网关能力契约）、AGENTS.md（架构接缝原则）

## 1. 背景与目标

游戏世界缺少市面游戏常见的「频道」概念。在右下角新增一个频道聊天面板：

- **主界面 = AI 聊天框**：默认选中「AI 助手」频道，玩家可随时向 AI 提问（去哪玩、怎么操作、世界知识）
- 附带「世界」「系统」只读频道，承接游戏事件播报，形成完整的频道体系
- AI 调用严格走现有回退链（网关 → 本地规则引擎），**永不阻塞业务**

## 2. UI 布局

```
收起态                                展开态
                    ┌────────────────────────────────┐
                    │ AI助手 | 世界 | 系统         ✕ │  ← 频道 Tab + 关闭
 [✉ 3] [speedo]     ├────────────────────────────────┤
                    │ 消息流（按当前频道过滤渲染）    │
                    ├────────────────────────────────┤
                    │ 小漫正在输入…（仅 AI 忙时）     │
                    ├────────────────────────────────┤
                    │ [输入框………………] [发送]        │
                    └────────────────────────────────┘
                      Enter 发送 · Esc 关闭
```

- 位置：`right: 26px`，收起按钮在 `bottom: 22px`（速度表下方，互不遮挡）；面板展开后向上生长
- 面板尺寸约 340×420px，深色玻璃风格（`var(--panel)` + `var(--line)`），与现有面板一致
- 驾驶时（`#speedo` 出现）面板自动降低透明度，不挡速度表
- 快捷键：`Enter` 开/关聊天（大地图打开时无效）；面板内 `Esc` 关闭

## 3. 频道模型

```js
channels = [
  { id: "ai",     name: "AI 助手", type: "interactive" },  // 交互式：输入走 AI 链路
  { id: "world",  name: "世界",    type: "log" },          // 只读：预留 NPC 对话/行为播报
  { id: "system", name: "系统",    type: "log" },          // 只读：游戏事件（进区、获得等）
]
```

- **统一消息结构**：`{ channel, from, text, kind: user|ai|system|npc, time, source? }`
- 所有消息进同一缓冲区，切频道 = 前端过滤渲染（零成本，将来可加「全部」聚合频道）
- 非当前频道的消息累计未读数，收起按钮显示红点徽标

## 4. 消息推送约定（对外接口）

其他系统往频道发消息统一用项目现有 CustomEvent 惯例，聊天面板监听、推送方零耦合：

```js
window.dispatchEvent(new CustomEvent("ws:chat", {
  detail: { channel: "system", from: "系统", text: "你进入了「潮汇坊」", kind: "system" },
}));
```

## 5. AI 调用链与模型选择

面板底部右侧为**模型选择器**（下拉菜单，仿市面聊天产品）：

```
├ ✦ DeepSeek          deepseek-chat   ← 网关预设（默认）
├ ✦ 通义千问           qwen-plus       ← 网关预设
├ ────────────────
├ ✦ 自定义模型         <model>         ← 已配置时出现
└ ⚙ 配置自定义模型…
```

- **网关预设**（key 只在服务端，符合 AGENTS.md 红线）：`.env` 中 `AI_CHAT_PROVIDER_<ID>_BASE_URL/_API_KEY/_MODEL` 定义多个聊天 provider，`chat` 能力入参带 `provider` 选择；启动时按 provider 各建一个 chat Agent（同一套「小漫」指令）
- **自定义模型**：前端直连 OpenAI 兼容 `/chat/completions`，endpoint/model/key 存浏览器 localStorage（仅聊天面板使用，沿用 aiConfig 的本地存储惯例）；网关不可用时的第三条路
- 调用链（选择失败逐级回退，**永不阻塞**）：

```
输入 → 按当前选中模型分流
  ├ 网关预设：gatewayAvailable() → invokeAbility("chat", { message, history, gameState, provider })
  ├ 自定义：fetch endpoint/chat/completions（OpenAI 兼容，带最近上下文 + 游戏状态）
  └ 任一步失败 → chatFallback.localReply(text) 本地规则引擎
```

- 模型选择持久化：localStorage `ws_chat_model`（`{type:"gateway", provider}` 或 `{type:"custom"}`）；网关返回 `PROVIDER_NOT_CONFIGURED` 时提示并走本地兜底

## 6. 交互细节（已知坑）

1. **按键冲突**：输入框聚焦时，`src/core/input.js` 的 keydown 监听跳过 INPUT/TEXTAREA/SELECT/contenteditable 目标（通用修复，顺带解决其他输入框抢 WASD 的老问题）
2. `Enter` 发送 / `Shift+Enter` 换行 / 空输入不发送；`Esc` 关闭并把焦点还给画布
3. 指针锁定期间聊天照常可用（纯键盘流）；面板点击不触发游戏拖视角（pointer-events 归属明确）

## 7. 文件落点

| 内容 | 位置 |
|---|---|
| 设计文档 | `docs/design/chat-channel-design.md`（本文件） |
| DOM 骨架 | `walkstreet/index.html`（`#chat-root`，挂在 `#hud` 内随 HUD 显隐） |
| 面板逻辑 | `walkstreet/src/ui/chatPanel.js`（`ChatPanel` 类，仿 `AISettingsPanel` 模式） |
| 本地兜底 | `walkstreet/src/ui/chatFallback.js`（纯函数 + 显式入参校验） |
| 样式 | `walkstreet/src/style.css` 新增 `/* ---------- chat ---------- */` 分区 |
| 按键修复 | `walkstreet/src/core/input.js`（keydown 跳过输入目标） |
| 装配/键位 | `walkstreet/src/main.js`（buildWorld 装配、disposeWorld 释放、Enter 开关） |
| 网关 Agent | `ai-gateway/src/mastra/agent.ts` 新增 chat-assistant，`index.ts` 按 provider 注册多个 chat Agent |
| 网关能力 | `ai-gateway/src/mastra/abilities/chat.ts` + `registry.ts` 注册（入参含 `provider`） |
| 网关多 provider | `ai-gateway/src/config.ts`（`AI_CHAT_PROVIDER_<ID>_*` 环境变量 → `chatProviders` 映射） |

## 8. 未来扩展（本期不做）

- NPC 对话接入「世界」频道（NPC 头顶气泡同步进频道流）
- HUD 区名切换 / 通知同步推「系统」频道（`ws:chat` 事件即可接入）
- 「全部」聚合频道、消息本地持久化、AI 流式输出（`invokeAbility` 换 SSE）
