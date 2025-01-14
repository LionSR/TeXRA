"""Model configuration data structures."""

from dataclasses import dataclass, field
from enum import Enum

from .tool_config import ToolConfig

# Default configuration values
DEFAULT_CONTEXT_WINDOW = 128000


@dataclass
class ModelCapabilities:
    """Model capabilities configuration."""

    supportsPromptCaching: bool = False
    supportsAutoPromptCaching: bool = False
    supportsReasoning: bool = False
    supportsVision: bool = True
    supportsNativePdf: bool = False
    supportsAssistantPrefill: bool = False
    upportsPredictiveOutput: bool = False
    likesToAskForConfirmation: bool = False


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
    fullName: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    provider: ModelProvider  # The model provider (e.g., ANTHROPIC, OPENAI)
    maxOutputTokens: int
    inputPrice: float
    outputPrice: float
    contextWindow: int = DEFAULT_CONTEXT_WINDOW
    capabilities: ModelCapabilities = field(default_factory=ModelCapabilities)
    openRouterOnly: bool = False  # Whether this model is only available through OpenRouter
    openrouterFullName: str | None = None  # Full model name for OpenRouter
    toolConfig: ToolConfig | None = None  # Reference to tool configuration
