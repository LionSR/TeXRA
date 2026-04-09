import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';
import { ModelHandlerXAI } from '@agent/modelHandlers/modelHandlerXAI';
import { ModelHandlerKimi } from '@agent/modelHandlers/modelHandlerKimi';
import { ModelHandlerDashScope } from '@agent/modelHandlers/modelHandlerDashScope';
import { ModelHandlerMiniMax } from '@agent/modelHandlers/modelHandlerMiniMax';
import { ModelHandlerGLM } from '@agent/modelHandlers/modelHandlerGLM';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/modelHandlerOpenRouterNative';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import * as logger from '@agent/core/logger';
import { GlobalStateKey, globalSM } from '@common/state';
import { getConfig } from '@utils/config';
import { getUseOpenRouter } from '@utils/config/providerConfig';

const CHANNEL = 'ModelFactory';
logger.initialize(CHANNEL);

const PROVIDER_HANDLERS = new Map<
  ModelProvider,
  new (config: ModelConfig) => ModelHandler<ProviderMessage>
>([
  [ModelProvider.ANTHROPIC, ModelHandlerAnthropic],
  [ModelProvider.OPENAI, ModelHandlerOpenAI],
  [ModelProvider.GOOGLE, ModelHandlerGoogleGenAI],
  [ModelProvider.DEEPSEEK, ModelHandlerDeepSeek],
  [ModelProvider.XAI, ModelHandlerXAI],
  [ModelProvider.MOONSHOT, ModelHandlerKimi],
  [ModelProvider.DASHSCOPE, ModelHandlerDashScope],
  [ModelProvider.MINIMAX, ModelHandlerMiniMax],
  [ModelProvider.GLM, ModelHandlerGLM],
  [ModelProvider.OTHERS, ModelHandlerOpenRouterNative],
]);

/**
 * Single source of truth: user-facing reasoning level strings → ReasoningEffort enum.
 * The reverse mapping (for the settings UI) is derived from this in SettingsViewMessageHandler.
 */
export const LEVEL_TO_EFFORT: Readonly<Record<string, ReasoningEffort>> = {
  none: ReasoningEffort.NONE,
  low: ReasoningEffort.LOW,
  medium: ReasoningEffort.MEDIUM,
  high: ReasoningEffort.HIGH,
};

/**
 * Apply the user's reasoning level override to a handler, returning it for chaining.
 * Only mutates capabilities when the model supports configurable effort and the
 * user has set an override.
 */
function withReasoningOverride<T extends ModelHandler>(handler: T): T {
  if (!handler.capabilities.supportsReasoningEffort) return handler;

  const level = globalSM.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  )[handler.config.name];
  const effort = level ? LEVEL_TO_EFFORT[level] : undefined;
  if (effort === undefined) return handler;

  logger.debug(
    CHANNEL,
    `Applying reasoning level override for ${handler.config.name}: ${level}`,
  );
  handler.capabilities.reasoningEffort = effort;
  return handler;
}

/** Check if OpenAI Responses API should be used for this config. */
function shouldUseResponsesAPI(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.provider !== ModelProvider.OPENAI || config.openRouterOnly) {
    return false;
  }
  return (
    config.requiresResponsesAPI ||
    (!useOpenRouter &&
      (getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
        config.fullName.startsWith('gpt-oss')))
  );
}

/**
 * Apply the user's "prefer short model names" setting.
 * When enabled, uses the model's shortName (e.g. "gpt-5.4") instead of the
 * date-pinned fullName (e.g. "gpt-5.4-2026-03-05"). Useful for proxies/gateways
 * that only accept unpinned model identifiers.
 */
function withShortModelName(config: ModelConfig): ModelConfig {
  if (!globalSM.get<boolean>(GlobalStateKey.PREFER_SHORT_MODEL_NAMES, false)) {
    return config;
  }
  const short = config.shortName;
  if (!short || short === config.fullName) return config;

  logger.debug(
    CHANNEL,
    `Using short model name for ${config.name}: ${config.fullName} → ${short}`,
  );
  return { ...config, fullName: short };
}

/**
 * Creates a model handler instance based on provider and routing configuration.
 * Applies short model name preference and reasoning level overrides.
 */
export function createModelHandler(originalConfig: ModelConfig): ModelHandler {
  const config = withShortModelName(originalConfig);
  const useOpenRouter = getUseOpenRouter();

  // OpenAI Responses API (required or optional)
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    return withReasoningOverride(new ModelHandlerOpenAIResponse(config));
  }

  // Route through OpenRouter if configured
  if (config.openRouterOnly || useOpenRouter) {
    const openrouterFullName =
      config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
    return withReasoningOverride(
      new ModelHandlerOpenRouterNative({ ...config, openrouterFullName }),
    );
  }

  // Direct provider handler
  const HandlerClass = PROVIDER_HANDLERS.get(config.provider);
  if (!HandlerClass) {
    throw new Error(`Unsupported model provider: ${config.provider}`);
  }
  logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
  return withReasoningOverride(new HandlerClass(config));
}
