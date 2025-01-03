"""Model configuration data structures."""

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
        """Initialize continue_limit."""
        self.continue_limit = CONFIRMATION_CONTINUE_LIMIT if self.capabilities.likes_to_ask_for_confirmation else DEFAULT_CONTINUE_LIMIT
