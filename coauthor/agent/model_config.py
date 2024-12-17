"""Model configuration data structures."""

import os
from dataclasses import dataclass, field
from enum import Enum

# Default configuration values
DEFAULT_CONTEXT_WINDOW = 128000
DEFAULT_INPUT_TOKEN_LIMIT = 1500000
DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5
DEFAULT_CONTINUE_LIMIT = 10
CONFIRMATION_CONTINUE_LIMIT = 20


@dataclass
class ModelCapabilities:
    """Model capabilities configuration."""

    supports_prompt_caching: bool = False
    supports_auto_prompt_caching: bool = False
    supports_reasoning: bool = False
    supports_vision: bool = True
    supports_native_pdf: bool = False
    supports_assistant_prefill: bool = False
    supports_predictive_output: bool = False
    likes_to_ask_for_confirmation: bool = False


class ModelProvider(Enum):
    """Enum for different model providers."""

    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    GOOGLE = "google"
    OTHERS = "others"


@dataclass
class ModelConfig:
    """Configuration for a model."""

    name: str  # Short name (e.g., "sonnet++")
    full_name: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    provider: ModelProvider  # The model provider (e.g., ANTHROPIC, OPENAI)
    max_output_tokens: int
    input_price: float
    output_price: float
    base_url: str | None = None
    context_window: int = DEFAULT_CONTEXT_WINDOW
    capabilities: ModelCapabilities = field(default_factory=ModelCapabilities)
    input_token_limit: int = DEFAULT_INPUT_TOKEN_LIMIT
    output_token_limit_factor: float = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR
    continue_limit: int = field(init=False)
    use_openrouter: bool = False  # Whether to use OpenRouter for this model
    openrouter_full_name: str | None = None  # Full model name for OpenRouter (e.g., "anthropic/claude-3-opus-20240229")

    def __post_init__(self):
        """Initialize continue_limit and handle OpenRouter configuration."""
        self.continue_limit = CONFIRMATION_CONTINUE_LIMIT if self.capabilities.likes_to_ask_for_confirmation else DEFAULT_CONTINUE_LIMIT

        # If model name ends with OR, it should use OpenRouter
        if self.name.endswith("OR"):
            self.use_openrouter = True
            self.name = self.name[:-2]  # Remove OR suffix

        # Set OpenRouter model name if not provided
        if self.use_openrouter and not self.openrouter_full_name:
            # Default format is "{provider}/{model_name}"
            self.openrouter_full_name = f"{self.provider.value}/{self.full_name}"

    def get_api_key(self) -> str:
        """Get API key based on provider and OpenRouter configuration."""
        if self.use_openrouter:
            if key := os.getenv("OPENROUTER_API_KEY"):
                return key
            raise ValueError("Missing OPENROUTER_API_KEY in environment")

        env_key = f"{self.provider.value.upper()}_API_KEY"
        if key := os.getenv(env_key):
            return key
        raise ValueError(f"Missing {env_key} in environment")

    def get_base_url(self) -> str | None:
        """Get base URL based on provider and OpenRouter configuration."""
        if self.use_openrouter:
            return "https://openrouter.ai/api/v1"

        # Provider-specific base URLs
        BASE_URLS = {
            ModelProvider.GOOGLE: "https://generativelanguage.googleapis.com/v1beta/openai/",
            ModelProvider.OPENAI: None,  # OpenAI uses default base URL
            ModelProvider.ANTHROPIC: None,  # Anthropic uses default base URL
        }
        return BASE_URLS.get(self.provider)
