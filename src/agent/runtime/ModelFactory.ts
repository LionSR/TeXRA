import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { ModelHandlerAnthropic } from '@agent/modelHandlers/modelHandlerAnthropic';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';
import { ModelHandlerXAI } from '@agent/modelHandlers/modelHandlerXAI';
import { ModelHandlerKimi } from '@agent/modelHandlers/modelHandlerKimi';
import { ModelHandlerDashScope } from '@agent/modelHandlers/modelHandlerDashScope';
import {
  ModelHandlerOpenRouter,
  ModelHandlerAnthropicViaOpenRouter,
} from '@agent/modelHandlers/modelHandlerOpenRouter';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/modelHandlerOpenAI';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { GlobalStateKey, globalSM } from '@common/state';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

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
  [ModelProvider.OTHERS, ModelHandlerOpenRouter],
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

  const overrides = globalSM.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  );
  const level = overrides[handler.config.name];
  if (!level) return handler;

  const effort = LEVEL_TO_EFFORT[level];
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
  if (config.requiresResponsesAPI) {
    return true;
  }
  if (useOpenRouter) {
    return false;
  }
  return (
    getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
    config.fullName.startsWith('gpt-oss')
  );
}

/**
 * Apply a user's custom model name override to a config, if set.
 * Returns a new config with the overridden fullName, or the original if no override.
 */
function withCustomModelName(config: ModelConfig): ModelConfig {
  const overrides = globalSM.get<Record<string, string>>(
    GlobalStateKey.CUSTOM_MODEL_NAMES,
    {},
  );
  const customName = overrides[config.name];
  if (!customName) return config;

  logger.debug(
    CHANNEL,
    `Applying custom model name for ${config.name}: ${config.fullName} → ${customName}`,
  );
  return { ...config, fullName: customName };
}

/**
 * Creates a model handler instance based on provider and routing configuration.
 * Applies user custom model name and reasoning level overrides.
 */
export function createModelHandler(originalConfig: ModelConfig): ModelHandler {
  const config = withCustomModelName(originalConfig);
  const useOpenRouter = getConfig<boolean>('texra.model.useOpenRouter', false);

  // OpenAI Responses API (required or optional)
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    return withReasoningOverride(new ModelHandlerOpenAIResponse(config));
  }

  // Route through OpenRouter if configured
  if (config.openRouterOnly || useOpenRouter) {
    const openrouterFullName =
      config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
    if (config.provider === ModelProvider.ANTHROPIC) {
      return withReasoningOverride(
        new ModelHandlerAnthropicViaOpenRouter({
          ...config,
          openrouterFullName,
        }),
      );
    }
    return withReasoningOverride(
      new ModelHandlerOpenRouter({ ...config, openrouterFullName }),
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
