import { Mastra } from "@mastra/core";
import type { Agent } from "@mastra/core/agent";
import { loadConfig, createModel, modelConfigured, type GatewayConfig } from "../config.js";
import { createFaceStylistAgent, createImageStylistAgent } from "./agent.js";

/* 网关唯一的 Mastra 实例：所有 Agent 在此注册（规范见设计文档第 7 节）。
 * 模型未配置时 mastra 为 null，能力调用统一返回 503。 */

export interface MastraRuntime {
  mastra: Mastra | null;
  faceStylist: Agent | null;
  imageStylist: Agent | null;
  config: GatewayConfig;
}

export function createRuntime(): MastraRuntime {
  const config = loadConfig();
  let mastra: Mastra | null = null;
  let faceStylist: Agent | null = null;
  let imageStylist: Agent | null = null;

  if (modelConfigured(config)) {
    try {
      faceStylist = createFaceStylistAgent(createModel(config));
      // image-stylist 用视觉模型（未配置 visionModel 时回退主模型）
      imageStylist = createImageStylistAgent(createModel(config, { vision: true }));
      mastra = new Mastra({ agents: { faceStylist, imageStylist } });
    } catch (e) {
      console.error("[mastra] Agent 初始化失败，网关将以未配置模式启动:", (e as Error).message);
      faceStylist = null;
      imageStylist = null;
      mastra = null;
    }
  }

  return { mastra, faceStylist, imageStylist, config };
}
