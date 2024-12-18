"""Factory for creating model handlers."""

from .model_config import ModelConfig, ModelProvider
from .model_handler import ModelHandler
from .model_handler_anthropic import AnthropicHandler
from .model_handler_openai import OpenAIHandler, GoogleviaOpenAIHandler, OpenRouterHandler


class ModelFactory:
    """Factory for creating model handlers with appropriate handlers."""

    @staticmethod
    def create_handler(config: ModelConfig) -> ModelHandler:
        """Create model handler based on provider and OpenRouter configuration."""
        # Handle OpenRouter configuration - this takes precedence over provider
        if config.use_openrouter or config.name.endswith("OR"):
            # Ensure use_openrouter is set if name ends with OR
            config.use_openrouter = True
            if config.name.endswith("OR"):
                config.name = config.name[:-2]  # Remove OR suffix
            return OpenRouterHandler(config)

        # Map providers to their handler classes
        handler_map = {
            ModelProvider.ANTHROPIC: AnthropicHandler,
            ModelProvider.OPENAI: OpenAIHandler,
            ModelProvider.GOOGLE: GoogleviaOpenAIHandler,
            ModelProvider.OTHERS: OpenRouterHandler,
        }

        handler_class = handler_map.get(config.provider)
        if not handler_class:
            raise ValueError(f"Unsupported model provider: {config.provider}")

        return handler_class(config)
