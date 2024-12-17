"""Base model configuration classes and types."""

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from ..logger import logger

from ..agent import AgentSettings, AgentConfig
from ..agent.agent_state import AgentGlobalState, AgentRoundState

from ..utils.img import get_base64_encoded_image, page_count_pdf, process_pdf_input

from .response_usage import OpenAIResponseUsage, AnthropicResponseUsage
from .agent_state import ToolState


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
    OPENROUTER = "openrouter"

    def get_api_key(self) -> str:
        """Get API key from environment variables."""
        key = os.getenv(f"{self.value.upper()}_API_KEY")
        if not key:
            raise ValueError(f"{self.value.upper()}_API_KEY environment variable not set")
        return key

    def get_base_url(self) -> str | None:
        """Get base URL for API requests."""
        urls = {
            self.OPENROUTER: "https://openrouter.ai/api/v1",
            self.GOOGLE: "https://generativelanguage.googleapis.com/v1beta",
            self.OPENAI: None,
        }
        return urls.get(self)


@dataclass
class ModelHandler(ABC):
    """Base class for model configurations."""

    name: str  # Short name (e.g., "sonnet++")
    full_name: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    max_output_tokens: int
    input_price: float
    output_price: float
    provider: ModelProvider
    base_url: str | None = None
    context_window: int = 128000
    capabilities: ModelCapabilities = field(default_factory=ModelCapabilities)

    # Added class-level constants
    CONTINUE_LIMIT: int = field(init=False)
    INPUT_TOKEN_LIMIT: int = 1500000
    OUTPUT_TOKEN_LIMIT_FACTOR: float = 2.5

    def __post_init__(self):
        """Initialize dependent attributes after dataclass initialization."""
        self.CONTINUE_LIMIT = 20 if self.capabilities.likes_to_ask_for_confirmation else 10

    @property
    def is_anthropic(self) -> bool:
        return self.provider == ModelProvider.ANTHROPIC

    @property
    def is_openai(self) -> bool:
        return self.provider == ModelProvider.OPENAI

    @property
    def is_google(self) -> bool:
        return self.provider == ModelProvider.GOOGLE

    @property
    def is_openrouter(self) -> bool:
        return self.provider == ModelProvider.OPENROUTER

    @property
    def is_openai_compatible(self) -> bool:
        return self.is_openai or self.is_openrouter or self.is_google

    @abstractmethod
    def get_client(self) -> Any:
        """Get the appropriate client for this model."""
        pass

    @abstractmethod
    def create_response(
        self,
        client: Any,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = None,
        end_tag: str | None = None,
    ) -> Any:
        """Create a response using the appropriate API call for this model."""
        pass

    @abstractmethod
    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: str | None = None) -> list[dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def create_reflection_message(self, messages: list[dict], user_message: str, figure_files=None) -> list[dict]:
        """Create a reflection message and handle prompt caching."""
        pass

    @abstractmethod
    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for the model."""
        pass

    @abstractmethod
    def extract_response(self, response_object, end_tag: str, auto_confirmation: bool = False) -> tuple[str, Any, str]:
        """Extract statistics from the response object.
        Returns: (new_response, response_usage, stop_reason)
        """
        pass

    def process_image(self, figure_file: str, file_extension: str):
        """Process image for models."""
        img_data = get_base64_encoded_image(figure_file)
        if file_extension.lower() in [".jpg", ".jpeg"]:
            media_type = "image/jpeg"
        elif file_extension.lower() == ".png":
            media_type = "image/png"
        elif file_extension.lower() == ".pdf":
            if self.capabilities.supports_native_pdf and page_count_pdf(figure_file) > 1:
                media_type = "application/pdf"
            else:
                img_data = process_pdf_input(figure_file)
                media_type = "image/png"
        else:
            raise ValueError(f"Unsupported file extension: {file_extension}")

        return img_data, media_type

    @abstractmethod
    def handle_continuation(
        self,
        messages: list[dict],
        round_state: AgentRoundState,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for a model when response is truncated."""
        pass

    @abstractmethod
    def initialize_output_and_prefill(
        self,
        # Core configs (required)
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        # State/content (required)
        messages: list[dict],
        tool_state: ToolState,
        # Processing parameters (required)
        output_file: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill based on model requirements."""
        pass

    @abstractmethod
    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        pass

    @abstractmethod
    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage | AnthropicResponseUsage:
        """Compute model-specific statistics from response usage object."""
        pass

    def check_stop_conditions(
        self, stop_reason: str, new_response: str, round_state: AgentRoundState, global_state: AgentGlobalState, agent_settings: AgentSettings
    ) -> tuple[bool, bool]:
        """Check if the conversation should stop and print debug info if stopping."""

        OUTPUT_TOKEN_LIMIT = self.OUTPUT_TOKEN_LIMIT_FACTOR * global_state.first_input_tokens if global_state.first_input_tokens > 0 else float("inf")

        end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
        encounter_document_tag = f"</{agent_settings.document_tag}>" in new_response
        continuation_limit = round_state.continuation_count > self.CONTINUE_LIMIT
        input_token_limit = global_state.total_input_tokens > self.INPUT_TOKEN_LIMIT
        output_token_limit = global_state.total_output_tokens > OUTPUT_TOKEN_LIMIT

        if output_token_limit:
            logger.error(f"Output tokens exceed {self.OUTPUT_TOKEN_LIMIT_FACTOR}x input tokens - halting process")
            logger.error(f"Total output tokens: {global_state.total_output_tokens}, First input tokens: {global_state.first_input_tokens}")

        should_stop = encounter_document_tag or continuation_limit or input_token_limit
        # or output_token_limit

        # Print debug info if stopping
        if should_stop:
            logger.debug(
                f"Stop flags:\n"
                f"end_turn: {end_turn}\n"
                f"encounter_document_tag: {encounter_document_tag}\n"
                f"continuation_limit: {continuation_limit}\n"
                f"input_token_limit: {input_token_limit}\n"
                f"output_token_limit: {output_token_limit}\n"
            )

        return end_turn, should_stop

    def create_image_message(self, figure_files):
        """Create image messages for the conversation."""
        image_contents = []
        added_figures = []

        for figure_file in figure_files:
            if not os.path.exists(figure_file) or os.path.getsize(figure_file) == 0:
                logger.error(f"File not found or empty: {figure_file}")
                continue

            file_extension = os.path.splitext(figure_file)[1].lower()

            try:
                img_data, media_type = self.process_image(figure_file, file_extension)
                logger.debug(f"Processed image: {figure_file}, type: {media_type}")

                if isinstance(img_data, list):
                    logger.debug(f"Adding {len(img_data)} pages to the image contents")
                    for i, data in enumerate(img_data):
                        image_contents.append({"file_name": f"{os.path.basename(figure_file)}_page_{i+1}", "data": data, "media_type": media_type})
                    added_figures.extend([f"{figure_file}_page_{i+1}" for i in range(len(img_data))])
                else:
                    logger.debug(f"Adding single page to the image contents: {figure_file}")
                    image_contents.append({"file_name": os.path.basename(figure_file), "data": img_data, "media_type": media_type})
                    added_figures.append(figure_file)
            except Exception as e:
                logger.error(f"Failed to process image {figure_file}: {e}")
                continue

        logger.info(f"Using images: {figure_files}")
        logger.info(f"Successfully added: {added_figures}")

        return self.create_image_content(image_contents)

    @abstractmethod
    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState) -> None:
        """Update the message content based on model-specific requirements."""
        pass
