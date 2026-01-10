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

/** Factory class for instantiating appropriate model handlers based on configuration. */
export class ModelFactory {
  /** Creates a model handler instance based on provider and routing configuration. */
  static createHandler(config: ModelConfig): ModelHandler {
    const isOpenAI = config.provider === ModelProvider.OPENAI;

    // Models requiring Responses API must bypass OpenRouter (e.g., deep research)
    if (isOpenAI && config.requiresResponsesAPI) {
      logger.debug(CHANNEL, 'Using OpenAI Responses API Handler (required)');
      return new ModelHandlerOpenAIResponse(config);
    }

    // Route through OpenRouter if configured
    const useOpenRouter =
      config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false);
    if (useOpenRouter) {
      config.openrouterFullName ??= `${config.provider}/${config.fullName}`;
      return config.provider === ModelProvider.ANTHROPIC
        ? new ModelHandlerAnthropicViaOpenRouter(config)
        : new ModelHandlerOpenRouter(config);
    }

    // Check for optional OpenAI Responses API usage
    if (isOpenAI) {
      const useResponsesAPI =
        getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
        config.fullName.startsWith('gpt-oss');
      if (useResponsesAPI) {
        logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
        return new ModelHandlerOpenAIResponse(config);
      }
    }

    // Use direct provider handler
    const HandlerClass = PROVIDER_HANDLERS.get(config.provider);
    if (!HandlerClass) {
      throw new Error(`Unsupported model provider: ${config.provider}`);
    }

    logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
    return new HandlerClass(config);
  }
}
