# AI 网关测试用例（阶段 1 验收）

> 状态：active ｜ 创建：2026-11-17 ｜ 最后更新：2026-11-17
> 执行方式：手动执行 + 结果回填（结果列填 通过/失败 + 日期）。全部通过后 M1 里程碑达成。

## 前置条件

```powershell
# 1. 启动网关（首次需安装依赖）
cd c:\Users\jinxiaofei\Desktop\open-world\ai-gateway
npm install
Copy-Item .env.example .env    # 然后编辑 .env 填入 API Key
npm run dev                    # 默认 http://127.0.0.1:8788

# 2. 启动前端
cd c:\Users\jinxiaofei\Desktop\open-world\walkstreet
npm run dev
```

## 用例表

| # | 用例 | 步骤 | 预期 | 结果 |
|---|---|---|---|---|
| TC-01 | 网关健康检查 | `curl http://127.0.0.1:8788/health` | 返回 `{"ok":true,...}`，含模型配置状态 | |
| TC-02 | 能力清单 | `curl http://127.0.0.1:8788/api/ai/abilities` | 返回数组，包含 `face-refine` 及其描述/入参说明 | |
| TC-03 | 能力调用-参数校验 | POST invoke，body 缺 `prompt` 字段 | 返回 400 + 明确错误信息，不触发模型调用 | |
| TC-04 | face-refine 正常调用 | POST `{prompt:"大眼睛瓜子脸", currentConfig:{...默认}}`（需 .env 配好 Key） | 返回 `{ok:true, reply, changes:{eyeSize,...}, source:"agent"}`，changes 仅含被提及参数且在范围内 | |
| TC-05 | face-refine 无 Key 降级 | .env 清空 Key 后重复 TC-04 | 返回明确错误（如 503 + "未配置模型"），前端可识别 | |
| TC-06 | 前端网关优先 | 启动网关 + 前端，捏脸输入"微笑"，打开浏览器 Network | 请求命中 `wsAiClient` → 网关 invoke；参数生效且提示来自 AI | |
| TC-07 | 前端回退-网关挂 | 停掉网关进程，前端重复捏脸 | 1–2 秒内回退：走旧直连（若配了 Key）或本地规则引擎，功能可用 | |
| TC-08 | 前端回退-网关报错 | .env 清 Key，网关运行，前端重复捏脸 | 回退到本地规则引擎并提示"已用本地方案" | |
| TC-09 | Key 不出浏览器 | 前端捏脸成功后，检查 localStorage `ws_creator_ai_config` 与 Network 请求头 | 无任何请求携带明文 apiKey 到模型厂商；直连回退仅在用户此前自行配置时生效 | |
| TC-10 | 非法 JSON 防御 | 用自定义 endpoint 模拟返回非 JSON（可临时改模型名触发） | 网关返回结构化错误，不崩溃；前端回退 | |
| TC-11 | CORS | 从 `http://localhost:5173` 页面发起调用 | 无 CORS 报错（网关允许本地开发来源） | |
| TC-12 | 并发冒烟 | 两个浏览器窗口同时捏脸 | 均正常返回，互不干扰 | |

## 已知限制（阶段 1 范围外，不作为失败项）

- 无鉴权/多租户（仅本机开发使用；公网部署前必须补）
- 无流式对话能力（face-refine 为结构化 JSON 输出）
- 无调用日志持久化（阶段 1.5）
