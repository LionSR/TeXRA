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

/** Map user-facing reasoning level strings to the ReasoningEffort enum. */
const LEVEL_TO_EFFORT: Record<string, ReasoningEffort> = {
  none: ReasoningEffort.NONE,
  low: ReasoningEffort.LOW,
  medium: ReasoningEffort.MEDIUM,
  high: ReasoningEffort.HIGH,
};

/**
 * Apply the user's reasoning level override to a handler's capabilities.
 * Only applies if the model supports configurable reasoning effort and the
 * user has set an override for this model.
 */
function applyReasoningLevelOverride(handler: ModelHandler): void {
  if (!handler.capabilities.supportsReasoningEffort) return;

  const overrides = globalSM.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  );
  const level = overrides[handler.config.name];
  if (!level) return;

  const effort = LEVEL_TO_EFFORT[level];
  if (effort === undefined) return;

  logger.debug(
    CHANNEL,
    `Applying reasoning level override for ${handler.config.name}: ${level}`,
  );
  handler.capabilities.reasoningEffort = effort;
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
 * Creates a model handler instance based on provider and routing configuration.
 * Applies user reasoning level overrides when the model supports configurable effort.
 */
export function createModelHandler(config: ModelConfig): ModelHandler {
  const useOpenRouter = getConfig<boolean>('texra.model.useOpenRouter', false);

  let handler: ModelHandler;

  // OpenAI Responses API (required or optional)
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    handler = new ModelHandlerOpenAIResponse(config);
  } else if (config.openRouterOnly || useOpenRouter) {
    // Route through OpenRouter if configured
    const openrouterFullName =
      config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
    if (config.provider === ModelProvider.ANTHROPIC) {
      handler = new ModelHandlerAnthropicViaOpenRouter({
        ...config,
        openrouterFullName,
      });
    } else {
      handler = new ModelHandlerOpenRouter({ ...config, openrouterFullName });
    }
  } else {
    // Direct provider handler
    const HandlerClass = PROVIDER_HANDLERS.get(config.provider);
    if (!HandlerClass) {
      throw new Error(`Unsupported model provider: ${config.provider}`);
    }
    logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
    handler = new HandlerClass(config);
  }

  // Apply user reasoning level override (if configured for this model)
  applyReasoningLevelOverride(handler);

  return handler;
}
