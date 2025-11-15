// Local imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelCapabilities,
  ModelConfig,
  ModelProvider,
  ReasoningEffort,
} from '@model/ModelConfig';

const VSCODE_LM_DEFAULT_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsVision: true,
  supportsNativePdf: false,
};

const VSCODE_LM_REASONING_CAPABILITIES: ModelCapabilities = {
  ...DEFAULT_MODEL_CAPABILITIES,
  supportsVision: false,
  supportsNativePdf: false,
  supportsReasoning: true,
};

/**
 * VS Code Language Model API models.
 * These models are accessible through VS Code's native Language Model API
 * and don't require separate API keys - authentication is handled through
 * VS Code extensions (e.g., GitHub Copilot, Claude extension, etc.)
 *
 * Model families supported (as of early 2025):
 * - GPT-4o series (via Copilot)
 * - O1 series (via Copilot)
 * - Claude 3.5 Sonnet (via Claude extension or Copilot)
 */
export const VSCODE_LM_MODELS: Record<string, ModelConfig> = {
  // GPT-4o series - Most capable general-purpose models
  vslm4o: {
    name: 'vslm4o',
    fullName: 'gpt-4o', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 16384,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  vslm4om: {
    name: 'vslm4om',
    fullName: 'gpt-4o-mini', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 16384,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.LOW,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },

  // O1 series - Advanced reasoning models
  vslmo1: {
    name: 'vslmo1',
    fullName: 'o1', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 100000,
    contextWindow: 200000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_REASONING_CAPABILITIES,
      reasoningEffort: ReasoningEffort.HIGH,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  vslmo1m: {
    name: 'vslmo1m',
    fullName: 'o1-mini', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 65536,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_REASONING_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },

  // Claude 3.5 Sonnet - Anthropic's most capable model
  vsclaud35s: {
    name: 'vsclaud35s',
    fullName: 'claude-3-5-sonnet', // Family name for VS Code Language Model API
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 8192,
    contextWindow: 200000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },

  // Legacy aliases for backward compatibility
  copilot4o: {
    name: 'copilot4o',
    fullName: 'gpt-4o',
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 16384,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  copilot4: {
    name: 'copilot4',
    fullName: 'gpt-4',
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 8192,
    contextWindow: 128000,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      reasoningEffort: ReasoningEffort.MEDIUM,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
  copilot35: {
    name: 'copilot35',
    fullName: 'gpt-3.5-turbo',
    provider: ModelProvider.COPILOT,
    maxOutputTokens: 4096,
    contextWindow: 16385,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: {
      ...VSCODE_LM_DEFAULT_CAPABILITIES,
      supportsVision: false,
      reasoningEffort: ReasoningEffort.LOW,
    } satisfies ModelCapabilities,
    openRouterOnly: false,
  },
};
