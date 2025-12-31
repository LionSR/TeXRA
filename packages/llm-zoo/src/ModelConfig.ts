/**
 * Configuration types and constants for language model interactions and capabilities.
 * This module provides a comprehensive type system for describing LLM capabilities,
 * pricing, and provider-specific configurations.
 *
 * @packageDocumentation
 */

/**
 * Default context window size in tokens.
 * Used as fallback when model doesn't specify a custom context window.
 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * Reasoning effort levels for models that support configurable reasoning depth.
 * Higher effort typically results in better reasoning quality but increased latency and cost.
 */
export enum ReasoningEffort {
  /** Extra high reasoning effort - maximum depth analysis */
  XHIGH = 'xhigh',
  /** High reasoning effort - thorough analysis */
  HIGH = 'high',
  /** Medium reasoning effort - balanced analysis */
  MEDIUM = 'medium',
  /** Low reasoning effort - quick analysis */
  LOW = 'low',
  /** No explicit reasoning - standard model behavior */
  NONE = 'none',
}

/**
 * Supported language model providers.
 * Each provider has specific API formats, capabilities, and pricing structures.
 */
export enum ModelProvider {
  /** Anthropic (Claude models) */
  ANTHROPIC = 'anthropic',
  /** OpenAI (GPT, o-series models) */
  OPENAI = 'openai',
  /** Google (Gemini models) */
  GOOGLE = 'google',
  /** DeepSeek (V3, R1 models) */
  DEEPSEEK = 'deepseek',
  /** xAI (Grok models) */
  XAI = 'xai',
  /** Moonshot AI (Kimi models) */
  MOONSHOT = 'moonshot',
  /** Alibaba DashScope (Qwen models) */
  DASHSCOPE = 'dashscope',
  /** GitHub Copilot */
  COPILOT = 'copilot',
  /** Other providers (OpenRouter-only models, etc.) */
  OTHERS = 'others',
}

/**
 * Feature flags defining a model's supported capabilities and behaviors.
 * These capabilities help determine which features can be used with a specific model.
 */
export interface ModelCapabilities {
  /** Whether the model supports function/tool calling */
  supportsFunctionCalling: boolean;

  /** Whether the model supports native MCP (Model Context Protocol) servers */
  supportsNativeMCPServer: boolean;

  /** Whether the model has built-in web search capability */
  supportsNativeWebSearch: boolean;

  /** Whether the model can execute code natively (e.g., Python sandbox) */
  supportsNativeCodeExecution: boolean;

  /** Whether the model supports explicit prompt caching */
  supportsPromptCaching: boolean;

  /** Whether the model automatically caches prompts without explicit markers */
  supportsAutoPromptCaching: boolean;

  /**
   * Cost multiplier for cached tokens (0.0-1.0).
   * Lower values mean greater savings when using cached content.
   * Example: 0.1 means cached tokens cost 10% of normal price.
   */
  cacheDiscountFactor: number;

  /** Whether the model supports extended reasoning/thinking */
  supportsReasoning: boolean;

  /** Whether reasoning can be interleaved with regular output */
  supportsInterleavedThinking: boolean;

  /** Whether the model supports configurable reasoning effort levels */
  supportsReasoningEffort: boolean;

  /** Default reasoning effort level when reasoning is enabled */
  reasoningEffort: ReasoningEffort;

  /** Whether the model can process images */
  supportsVision: boolean;

  /** Whether the model can process PDF documents natively */
  supportsNativePdf: boolean;

  /** Whether the model can process audio input natively */
  supportsNativeAudio: boolean;

  /** Whether the model supports assistant message prefilling */
  supportsAssistantPrefill: boolean;

  /** Whether the model supports predictive/speculative output */
  supportsPredictiveOutput: boolean;

  /** Whether the model provides accurate token counting */
  supportsTokenCounting: boolean;

  /** Whether the model supports system prompts */
  supportsSystemPrompt: boolean;

  /** Whether the model supports intermediate developer messages */
  supportsIntermDevMsgs: boolean;
}

/**
 * Base model capabilities with sensible defaults.
 * Models should spread this and override specific capabilities.
 */
export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsFunctionCalling: true,
  supportsNativeMCPServer: false,
  supportsNativeWebSearch: false,
  supportsNativeCodeExecution: false,
  supportsPromptCaching: false,
  supportsAutoPromptCaching: false,
  cacheDiscountFactor: 1.0,
  supportsReasoning: false,
  supportsInterleavedThinking: false,
  reasoningEffort: ReasoningEffort.NONE,
  supportsVision: true,
  supportsNativePdf: false,
  supportsAssistantPrefill: false,
  supportsPredictiveOutput: false,
  supportsTokenCounting: false,
  supportsSystemPrompt: true,
  supportsIntermDevMsgs: false,
  supportsReasoningEffort: false,
  supportsNativeAudio: false,
};

/**
 * Complete configuration for a language model.
 * Contains all metadata needed to work with the model including
 * pricing, capabilities, and provider-specific settings.
 */
export interface ModelConfig {
  /**
   * Short identifier for the model (e.g., "sonnet45", "gpt4o").
   * Used as the key in the registry and for quick reference.
   */
  name: string;

  /**
   * Full API model identifier (e.g., "claude-sonnet-4-5", "gpt-4o-2024-11-20").
   * This is the actual string sent to the provider's API.
   */
  fullName: string;

  /** The model's provider */
  provider: ModelProvider;

  /** Maximum tokens the model can generate in a single response */
  maxOutputTokens: number;

  /** Cost per million input tokens in USD */
  inputPrice: number;

  /** Cost per million output tokens in USD */
  outputPrice: number;

  /** Maximum context window size in tokens */
  contextWindow: number;

  /** Model capability flags */
  capabilities: ModelCapabilities;

  /**
   * Whether this model is only available through OpenRouter.
   * When true, direct API access is not available.
   */
  openRouterOnly: boolean;

  /**
   * Model identifier for OpenRouter API.
   * Example: "anthropic/claude-sonnet-4.5"
   */
  openrouterFullName?: string;

  /**
   * Custom base URL for this specific model.
   * Overrides the provider's default endpoint.
   */
  baseUrl?: string;

  /**
   * Whether this model requires OpenAI's Responses API format.
   * Used for special models like deep research that bypass standard chat completions.
   */
  requiresResponsesAPI?: boolean;
}
