"""Factory for creating model handlers."""

from .model_config import ModelConfig, ModelProvider
from .model_operations import ModelOperations
from .model_operations_anthropic import AnthropicOperations
from .model_operations_openai import OpenAIOperations, OpenAICompatibleOperations, OpenRouterOperations


class ModelFactory:
    """Factory for creating model handlers with appropriate operations."""

    @staticmethod
    def create_operations(config: ModelConfig) -> ModelOperations:
        """Create model operations based on provider and OpenRouter configuration."""
        # Handle OpenRouter configuration - this takes precedence over provider
        if config.use_openrouter or config.name.endswith("OR"):
            # Ensure use_openrouter is set if name ends with OR
            config.use_openrouter = True
            if config.name.endswith("OR"):
                config.name = config.name[:-2]  # Remove OR suffix
            return OpenRouterOperations(config)

        # Map providers to their operation classes
        operations_map = {
            ModelProvider.ANTHROPIC: AnthropicOperations,
            ModelProvider.OPENAI: OpenAIOperations,
            ModelProvider.GOOGLE: OpenAICompatibleOperations,
            ModelProvider.OTHERS: OpenRouterOperations,  # Use OpenAI-compatible for other providers
        }

        operations_class = operations_map.get(config.provider)
        if not operations_class:
            raise ValueError(f"Unsupported model provider: {config.provider}")

        return operations_class(config)
