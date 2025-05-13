// Local imports - agent components
import { ModelConfig, ModelProvider } from '../model';

// Local imports - model handlers
import { ModelHandler } from './ModelHandler';
import { ModelHandlerAnthropic } from './modelHandlerAnthropic';
import { ModelHandlerGoogle } from './modelHandlerGoogle';
import { ModelHandlerGoogleGenAI } from './modelHandlerGoogleGenAI';
import { ModelHandlerDeepSeek } from './modelHandlerDeepSeek';
import { ModelHandlerXAI } from './modelHandlerXAI';
import { ModelHandlerKimi } from './modelHandlerKimi';
import { ModelHandlerDashScope } from './modelHandlerDashScope';
import {
  ModelHandlerOpenRouter,
  ModelHandlerAnthropicViaOpenRouter,
} from './modelHandlerOpenRouter';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

// Local imports - utils
import { getConfig } from '../utils/configUtils';
import * as logger from '../logger/logUtils';

// Initialize logger
const CHANNEL = 'ModelFactory';
logger.initialize(CHANNEL);

/** Factory class for instantiating appropriate model handlers based on configuration. */
export class ModelFactory {
  /**
   * Creates a model handler instance based on provider and routing configuration.
   * @param config Model configuration including provider and OpenRouter settings
   * @returns Appropriate ModelHandler instance for the configuration
   * @throws Error if provider is unsupported
   */
  static createHandler(config: ModelConfig): ModelHandler {
    // Use OpenRouter if model requires it or if explicitly configured in toolConfig
    const useOpenRouter =
      config.openRouterOnly || getConfig<boolean>('model.useOpenRouter', false);

    if (useOpenRouter) {
      // Set OpenRouter model name if not provided
      if (!config.openrouterFullName) {
        config.openrouterFullName = `${config.provider}/${config.fullName}`;
      }

      // Route to appropriate OpenRouter handler
      if (config.provider === ModelProvider.ANTHROPIC) {
        return new ModelHandlerAnthropicViaOpenRouter(config);
      }
      return new ModelHandlerOpenRouter(config);
    }

    // Check for native Google SDK usage *before* the general provider map
    const useNativeGoogleSDK = getConfig<boolean>(
      'model.useNativeGoogleSDK',
      false,
    );
    if (config.provider === ModelProvider.GOOGLE && useNativeGoogleSDK) {
      logger.debug(
        CHANNEL,
        'Using Native Google GenAI SDK Handler (ModelHandlerGoogleGenAI)',
      );
      return new ModelHandlerGoogleGenAI(config);
    }

    // Map providers to their handler classes (excluding the native Google handler handled above)
    const handlerMap = new Map<
      ModelProvider,
      new (config: ModelConfig) => ModelHandler
    >([
      [ModelProvider.ANTHROPIC, ModelHandlerAnthropic],
      [ModelProvider.OPENAI, ModelHandlerOpenAI],
      [ModelProvider.GOOGLE, ModelHandlerGoogle],
      [ModelProvider.DEEPSEEK, ModelHandlerDeepSeek],
      [ModelProvider.XAI, ModelHandlerXAI],
      [ModelProvider.MOONSHOT, ModelHandlerKimi],
      [ModelProvider.DASHSCOPE, ModelHandlerDashScope],
      [ModelProvider.OTHERS, ModelHandlerOpenRouter],
    ]);

    const HandlerClass = handlerMap.get(config.provider);
    if (!HandlerClass) {
      throw new Error(`Unsupported model provider: ${config.provider}`);
    }

    logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
    return new HandlerClass(config);
  }
}
