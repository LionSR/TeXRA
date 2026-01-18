import {
  ModelHandler,
  ModelHandlerAnthropic,
  ModelHandlerGoogleGenAI,
  ModelHandlerDeepSeek,
  ModelHandlerXAI,
  ModelHandlerKimi,
  ModelHandlerDashScope,
  ModelHandlerOpenRouter,
  ModelHandlerAnthropicViaOpenRouter,
  ModelHandlerOpenAI,
  ModelHandlerOpenAIResponse,
} from '@agent/modelHandlers';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import * as logger from '@logger/logUtils';
import { ModelConfig, ModelProvider } from '@model';
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

/** Check if OpenAI model should use Responses API. */
function shouldUseResponsesAPI(config: ModelConfig): boolean {
  // openRouterOnly models must always route through OpenRouter
  if (config.openRouterOnly) return false;
  if (config.requiresResponsesAPI) return true;
  if (!getConfig<boolean>('texra.model.useOpenRouter', false)) {
    return (
      getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
      config.fullName.startsWith('gpt-oss')
    );
  }
  return false;
}

/** Create config with OpenRouter name for routing. */
function withOpenRouterName(config: ModelConfig): ModelConfig {
  return {
    ...config,
    openrouterFullName:
      config.openrouterFullName || `${config.provider}/${config.fullName}`,
  };
}

/**
 * Creates a model handler instance based on provider and routing configuration.
 */
export function createModelHandler(config: ModelConfig): ModelHandler {
  // OpenAI Responses API (required or optional)
  if (
    config.provider === ModelProvider.OPENAI &&
    shouldUseResponsesAPI(config)
  ) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    return new ModelHandlerOpenAIResponse(config);
  }

  // Route through OpenRouter if configured
  const useOpenRouter =
    config.openRouterOnly ||
    getConfig<boolean>('texra.model.useOpenRouter', false);
  if (useOpenRouter) {
    const routerConfig = withOpenRouterName(config);
    if (config.provider === ModelProvider.ANTHROPIC) {
      return new ModelHandlerAnthropicViaOpenRouter(routerConfig);
    }
    return new ModelHandlerOpenRouter(routerConfig);
  }

  // Direct provider handler
  const HandlerClass = PROVIDER_HANDLERS.get(config.provider);
  if (!HandlerClass) {
    throw new Error(`Unsupported model provider: ${config.provider}`);
  }
  logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
  return new HandlerClass(config);
}
