"""Factory for creating model handlers."""

from .model_config import ModelConfig, ModelProvider
from .model_handler import ModelHandler
from .model_handler_openai import OpenAIHandler
from .model_handler_anthropic import AnthropicHandler
from .model_handler_others import (
    GoogleviaOpenAIHandler,
    OpenRouterHandler,
    AnthropicviaOpenrouterHandler,
)


class ModelFactory:
    """Factory for creating model handlers with appropriate handlers."""

    @staticmethod
    def create_handler(config: ModelConfig) -> ModelHandler:
        """Create model handler based on provider and OpenRouter configuration."""
        # Handle OpenRouter configuration
        if config.name.endswith("OR"):
            config.use_openrouter = True
            config.name = config.name[:-2]  # Remove OR suffix
            # Set OpenRouter model name if not provided
            if not config.openrouter_full_name:
                config.openrouter_full_name = f"{config.provider.value}/{config.full_name}"

            # Route to appropriate OpenRouter handler
            if config.provider == ModelProvider.ANTHROPIC:
                return AnthropicviaOpenrouterHandler(config)
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
