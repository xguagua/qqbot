import {
  MAX_ESTIMATED_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  type DeepSeekModel,
} from "../config";

interface ModelPricing {
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
}

// Conservative peak prices, converted to integer nano-USD per token.
// Sources: DeepSeek Models & Pricing, checked 2026-10-25.
export const MODEL_PRICING: Readonly<Record<DeepSeekModel, ModelPricing>> = {
  "deepseek-flash": {
    inputNanoUsdPerToken: 300,
    outputNanoUsdPerToken: 1_200,
  },
  "deepseek-v4-pro": {
    inputNanoUsdPerToken: 1_320,
    outputNanoUsdPerToken: 3_960,
  },
};

export interface DeepSeekUsage {
  promptTokens: number;
  completionTokens: number;
}

export function estimateMaxRequestCost(model: DeepSeekModel): number {
  const pricing = MODEL_PRICING[model];
  return (
    MAX_ESTIMATED_INPUT_TOKENS * pricing.inputNanoUsdPerToken +
    MAX_OUTPUT_TOKENS * pricing.outputNanoUsdPerToken
  );
}

export function actualRequestCost(model: DeepSeekModel, usage: DeepSeekUsage): number {
  const pricing = MODEL_PRICING[model];
  return (
    usage.promptTokens * pricing.inputNanoUsdPerToken +
    usage.completionTokens * pricing.outputNanoUsdPerToken
  );
}
