import { ModelConfig, ModelProvider } from './baseModel';

/**
 * Anthropic-specific configuration
 */
export interface AnthropicModelConfig extends ModelConfig {
  provider: ModelProvider.ANTHROPIC;
  // Add Anthropic-specific fields here
}

/**
 * OpenAI-specific configuration
 */
export interface OpenAIModelConfig extends ModelConfig {
  provider: ModelProvider.OPENAI;
  // Add OpenAI-specific fields here
}

/**
 * Configuration for OpenAI-compatible providers (OpenAI, OpenRouter, Google)
 */
export interface OpenAICompatibleConfig extends ModelConfig {
  provider:
    | ModelProvider.OPENAI
    | ModelProvider.OPENROUTER
    | ModelProvider.GOOGLE;
  // Add OpenAI-compatible specific fields here
}

/**
 * Default values for model configurations
 */
const DEFAULT_MODEL_CONFIG: Partial<ModelConfig> = {
  contextWindow: 128000,
  supportsPromptCaching: false,
  supportsReasoning: false,
  supportsVision: true,
  supportsNativePdf: false,
  supportsAssistantPrefill: false,
  supportsPredictiveOutput: false,
  likesToAskForConfirmation: false,
};

/**
 * Helper functions to create typed model configs with defaults
 */
function createAnthropicConfig(
  config: Partial<AnthropicModelConfig>,
): AnthropicModelConfig {
  return {
    ...DEFAULT_MODEL_CONFIG,
    provider: ModelProvider.ANTHROPIC,
    ...config,
  } as AnthropicModelConfig;
}

function createOpenAIConfig(
  config: Partial<OpenAIModelConfig>,
): OpenAIModelConfig {
  return {
    ...DEFAULT_MODEL_CONFIG,
    provider: ModelProvider.OPENAI,
    ...config,
  } as OpenAIModelConfig;
}

function createOpenAICompatibleConfig(
  config: Partial<OpenAICompatibleConfig> & { provider: ModelProvider },
): OpenAICompatibleConfig {
  return {
    ...DEFAULT_MODEL_CONFIG,
    ...config,
  } as OpenAICompatibleConfig;
}

/**
 * Registry of available model configurations
 */
export const MODEL_CONFIGS = {
  // Anthropic Models
  opus: createAnthropicConfig({
    name: 'opus',
    fullName: 'claude-3-opus-20240229',
    maxTokens: 4096,
    contextWindow: 200000,
    inputPrice: 15.0,
    outputPrice: 75.0,
    supportsPromptCaching: true,
    supportsAssistantPrefill: true,
  }),

  'sonnet++': createAnthropicConfig({
    name: 'sonnet++',
    fullName: 'claude-3-5-sonnet-20241022',
    maxTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsPromptCaching: true,
    supportsNativePdf: true,
    supportsAssistantPrefill: true,
    likesToAskForConfirmation: true,
  }),

  'sonnet+': createAnthropicConfig({
    name: 'sonnet+',
    fullName: 'claude-3-5-sonnet-20240620',
    maxTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsPromptCaching: true,
    supportsAssistantPrefill: true,
  }),

  sonnet: createAnthropicConfig({
    name: 'sonnet',
    fullName: 'claude-3-sonnet-20240229',
    maxTokens: 8192,
    contextWindow: 200000,
    inputPrice: 3.0,
    outputPrice: 15.0,
    supportsPromptCaching: false,
    supportsAssistantPrefill: true,
  }),

  'haiku+': createAnthropicConfig({
    name: 'haiku+',
    fullName: 'claude-3-5-haiku-20241022',
    maxTokens: 8192,
    contextWindow: 200000,
    inputPrice: 1.0,
    outputPrice: 5.0,
    supportsPromptCaching: true,
    supportsVision: false,
    supportsAssistantPrefill: true,
    likesToAskForConfirmation: true,
  }),

  haiku: createAnthropicConfig({
    name: 'haiku',
    fullName: 'claude-3-haiku-20240307',
    maxTokens: 8192,
    contextWindow: 200000,
    inputPrice: 0.25,
    outputPrice: 1.25,
    supportsPromptCaching: true,
    supportsAssistantPrefill: true,
  }),

  // OpenAI models
  o1: createOpenAIConfig({
    name: 'o1',
    fullName: 'o1-preview-2024-09-12',
    maxTokens: 32768,
    contextWindow: 128000,
    inputPrice: 15.0,
    outputPrice: 60.0,
    supportsVision: false,
    supportsReasoning: true,
  }),

  'o1-': createOpenAIConfig({
    name: 'o1-',
    fullName: 'o1-mini-2024-09-12',
    maxTokens: 65536,
    contextWindow: 128000,
    inputPrice: 3.0,
    outputPrice: 12.0,
    supportsVision: false,
    supportsReasoning: true,
  }),

  gpt4o: createOpenAIConfig({
    name: 'gpt4o',
    fullName: 'gpt-4o-2024-11-20',
    maxTokens: 16384,
    contextWindow: 128000,
    inputPrice: 2.5,
    outputPrice: 10.0,
    supportsPredictiveOutput: true,
  }),

  gpt4t: createOpenAIConfig({
    name: 'gpt4t',
    fullName: 'gpt-4-turbo-2024-04-09',
    maxTokens: 4096,
    contextWindow: 128000,
    inputPrice: 10.0,
    outputPrice: 30.0,
  }),

  'gpt4o-': createOpenAIConfig({
    name: 'gpt4o-',
    fullName: 'gpt-4o-mini-2024-07-18',
    maxTokens: 16384,
    contextWindow: 128000,
    inputPrice: 0.15,
    outputPrice: 0.6,
    supportsPredictiveOutput: true,
  }),

  gpt4ol: createOpenAIConfig({
    name: 'gpt4ol',
    fullName: 'chatgpt-4o-latest',
    maxTokens: 16384,
    contextWindow: 128000,
    inputPrice: 5.0,
    outputPrice: 15.0,
  }),

  // Google models
  geminiexp: createOpenAICompatibleConfig({
    name: 'geminiexp',
    fullName: 'gemini-exp-1206',
    provider: ModelProvider.GOOGLE,
    maxTokens: 4096,
    contextWindow: 2097152,
    inputPrice: 1.25,
    outputPrice: 5.0,
  }),

  gemini2f: createOpenAICompatibleConfig({
    name: 'gemini2f',
    fullName: 'gemini-2.0-flash-exp',
    provider: ModelProvider.GOOGLE,
    maxTokens: 8192,
    contextWindow: 1048576,
    inputPrice: 0.075,
    outputPrice: 0.3,
    supportsPromptCaching: false,
  }),

  'gemini1p+': createOpenAICompatibleConfig({
    name: 'gemini1p+',
    fullName: 'gemini-1.5-pro-latest',
    provider: ModelProvider.GOOGLE,
    maxTokens: 8192,
    inputPrice: 1.25,
    outputPrice: 5.0,
    supportsPromptCaching: true,
  }),

  'gemini1f+': createOpenAICompatibleConfig({
    name: 'gemini1f+',
    fullName: 'gemini-1.5-fresh-latest',
    provider: ModelProvider.GOOGLE,
    maxTokens: 8192,
    contextWindow: 1048576,
    inputPrice: 0.075,
    outputPrice: 0.3,
    supportsPromptCaching: true,
  }),

  // OpenRouter models
  gpt4oOR: createOpenAICompatibleConfig({
    name: 'gpt4oOR',
    fullName: 'openai/gpt-4o:extended',
    provider: ModelProvider.OPENROUTER,
    maxTokens: 64000,
    contextWindow: 128000,
    inputPrice: 6.0,
    outputPrice: 18.0,
  }),

  'gemini1p+OR': createOpenAICompatibleConfig({
    name: 'gemini1p+OR',
    fullName: 'google/gemini-pro-1.5',
    provider: ModelProvider.OPENROUTER,
    maxTokens: 8192,
    contextWindow: 2097152,
    inputPrice: 2.5,
    outputPrice: 7.5,
  }),

  'gemini1f+OR': createOpenAICompatibleConfig({
    name: 'gemini1f+OR',
    fullName: 'google/gemini-flash-1.5',
    provider: ModelProvider.OPENROUTER,
    maxTokens: 8192,
    contextWindow: 1048576,
    inputPrice: 0.075,
    outputPrice: 0.3,
  }),

  'llama3+OR': createOpenAICompatibleConfig({
    name: 'llama3+OR',
    fullName: 'meta-llama/llama-3.1-405b-instruct',
    provider: ModelProvider.OPENROUTER,
    maxTokens: 131072,
    contextWindow: 131072,
    inputPrice: 3.0,
    outputPrice: 3.0,
  }),

  'qwq-32bOR': createOpenAICompatibleConfig({
    name: 'qwq-32b',
    fullName: 'qwen/qwq-32b-preview',
    provider: ModelProvider.OPENROUTER,
    maxTokens: 32768,
    contextWindow: 32768,
    inputPrice: 0.15,
    outputPrice: 0.6,
  }),
} as const;

// Type for the model registry
export type ModelConfigRegistry = typeof MODEL_CONFIGS;
export type ModelName = keyof ModelConfigRegistry;

/**
 * Get a model configuration by name
 */
export function getModelConfig<T extends ModelName>(
  modelName: T,
): ModelConfigRegistry[T] {
  const config = MODEL_CONFIGS[modelName];
  if (!config) {
    throw new Error(`Unknown model: ${modelName}`);
  }
  return config;
}

/**
 * Get all available model names
 */
export function getAvailableModels(): ModelName[] {
  return Object.keys(MODEL_CONFIGS) as ModelName[];
}

/**
 * Get models by provider
 */
export function getModelsByProvider<T extends ModelProvider>(
  provider: T,
): ModelConfig[] {
  return Object.values(MODEL_CONFIGS).filter(
    (config) => config.provider === provider,
  );
}
