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

/**
 * Creates a model handler instance based on provider and routing configuration.
 */
export function createModelHandler(config: ModelConfig): ModelHandler {
  // OpenAI Responses API (required or optional)
  const useOpenRouter = getConfig<boolean>('texra.model.useOpenRouter', false);
  if (config.provider === ModelProvider.OPENAI && !config.openRouterOnly) {
    const useResponsesAPI =
      config.requiresResponsesAPI ||
      (!useOpenRouter &&
        (getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
          config.fullName.startsWith('gpt-oss')));
    if (useResponsesAPI) {
      logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
      return new ModelHandlerOpenAIResponse(config);
    }
  }

  // Route through OpenRouter if configured
  if (config.openRouterOnly || useOpenRouter) {
    const openrouterFullName =
      config.openrouterFullName || `${config.provider}/${config.fullName}`;
    if (config.provider === ModelProvider.ANTHROPIC) {
      return new ModelHandlerAnthropicViaOpenRouter({
        ...config,
        openrouterFullName,
      });
    }
    return new ModelHandlerOpenRouter({ ...config, openrouterFullName });
  }

  // Direct provider handler
  const HandlerClass = PROVIDER_HANDLERS.get(config.provider);
  if (!HandlerClass) {
    throw new Error(`Unsupported model provider: ${config.provider}`);
  }
  logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
  return new HandlerClass(config);
}
