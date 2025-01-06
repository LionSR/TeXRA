// Local imports - agent components
import { ModelConfig, ModelProvider } from './ModelConfig';
import { ModelHandler } from './ModelHandler';
import { ModelHandlerAnthropic } from './modelHandlerAnthropic';
import { ModelHandlerGoogle } from './modelHandlerGoogle';
import {
  ModelHandlerOpenRouter,
  ModelHandlerAnthropicViaOpenRouter,
} from './modelHandlerOpenRouter';
import { ModelHandlerOpenAI } from './modelHandlerOpenAI';

/** Factory class for instantiating appropriate model handlers based on configuration. */
export class ModelFactory {
  /**
   * Creates a model handler instance based on provider and routing configuration.
   * @param config Model configuration including provider and OpenRouter settings
   * @returns Appropriate ModelHandler instance for the configuration
   * @throws Error if provider is unsupported
   */
  static createHandler(config: ModelConfig): ModelHandler {
    // Handle OpenRouter configuration
    if (config.useOpenRouter) {
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

    // Map providers to their handler classes
    const handlerMap = new Map<
      ModelProvider,
      new (config: ModelConfig) => ModelHandler
    >([
      [ModelProvider.ANTHROPIC, ModelHandlerAnthropic],
      [ModelProvider.OPENAI, ModelHandlerOpenAI],
      [ModelProvider.GOOGLE, ModelHandlerGoogle],
      [ModelProvider.OTHERS, ModelHandlerOpenRouter],
    ]);

    const HandlerClass = handlerMap.get(config.provider);
    if (!HandlerClass) {
      throw new Error(`Unsupported model provider: ${config.provider}`);
    }

    return new HandlerClass(config);
  }
}
