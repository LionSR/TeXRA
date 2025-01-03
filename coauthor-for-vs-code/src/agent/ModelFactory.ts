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

/**
 * Factory for creating model handlers with appropriate handlers.
 */
export class ModelFactory {
  /**
   * Create model handler based on provider and OpenRouter configuration.
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
