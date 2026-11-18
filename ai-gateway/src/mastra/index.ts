import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { loadConfig, createModel, createModelFromProvider, modelConfigured, type GatewayConfig } from "../config.js";
import { createFaceStylistAgent, createImageStylistAgent, createChatAgent } from "./agent.js";

/* 网关唯一的 Mastra 实例：所有 Agent 在此注册（规范见设计文档第 7 节）。
 * 模型未配置时 mastra 为 null，能力调用统一返回 503。 */

export interface MastraRuntime {
  mastra: Mastra | null;
  faceStylist: Agent | null;
  imageStylist: Agent | null;
  /** chat 频道多模型：provider id → Agent（.env AI_CHAT_PROVIDER_* 定义） */
  chatAgents: Record<string, Agent>;
  config: GatewayConfig;
}

export function createRuntime(): MastraRuntime {
  const config = loadConfig();
  let faceStylist: Agent | null = null;
  let imageStylist: Agent | null = null;
  const chatAgents: Record<string, Agent> = {};
  const registry: Record<string, Agent> = {};

  if (modelConfigured(config)) {
    try {
      faceStylist = createFaceStylistAgent(createModel(config));
      // image-stylist 用视觉模型（未配置 visionModel 时回退主模型）
      imageStylist = createImageStylistAgent(createModel(config, { vision: true }));
      registry.faceStylist = faceStylist;
      registry.imageStylist = imageStylist;
    } catch (e) {
      console.error("[mastra] Agent 初始化失败，网关将以未配置模式启动:", (e as Error).message);
      faceStylist = null;
      imageStylist = null;
    }
  }

  // chat 多 provider 独立初始化（单个 provider 配置异常不影响其他能力）
  for (const [id, p] of Object.entries(config.chatProviders)) {
    try {
      const agent = createChatAgent(createModelFromProvider(p));
      chatAgents[id] = agent;
      registry[`chat_${id}`] = agent;
    } catch (e) {
      console.warn(`[mastra] chat provider "${id}" 初始化失败:`, (e as Error).message);
    }
  }

  const mastra = Object.keys(registry).length ? new Mastra({ agents: registry }) : null;
  return { mastra, faceStylist, imageStylist, chatAgents, config };
}
