"""Model-specific handlers."""

import os
from abc import ABC, abstractmethod
from typing import Any

from ..logger import logger

from ..agent import AgentSettings, AgentConfig
from ..agent.agent_state import AgentStateRound, AgentStateGlobal
from ..utils.img import get_base64_encoded_image, count_pdf_pages, process_pdf_input

from .model_config import ModelConfig, ModelProvider
from .tool_handler import ToolState


# Default continuation limits
DEFAULT_CONTINUE_LIMIT = 10
CONFIRMATION_CONTINUE_LIMIT = 20


class ModelHandler(ABC):
    """Base class for model-specific handlers."""

    def __init__(self, config: ModelConfig):
        self.config = config
        self.capabilities = config.capabilities
        self.continue_limit = CONFIRMATION_CONTINUE_LIMIT if self.capabilities.likes_to_ask_for_confirmation else DEFAULT_CONTINUE_LIMIT

    def get_api_key(self) -> str:
        """Get API key based on provider and OpenRouter configuration."""
        if self.config.use_openrouter:
            if key := os.getenv("OPENROUTER_API_KEY"):
                return key
            raise ValueError("Missing OPENROUTER_API_KEY in environment")

        env_key = f"{self.config.provider.value.upper()}_API_KEY"
        if key := os.getenv(env_key):
            return key
        raise ValueError(f"Missing {env_key} in environment")

    def get_base_url(self) -> str | None:
        """Get base URL based on provider and OpenRouter configuration."""
        if self.config.use_openrouter:
            return "https://openrouter.ai/api/v1"

        # Provider-specific base URLs
        BASE_URLS = {
            ModelProvider.GOOGLE: "https://generativelanguage.googleapis.com/v1beta/openai/",
            ModelProvider.OPENAI: None,  # OpenAI uses default base URL
            ModelProvider.ANTHROPIC: None,  # Anthropic uses default base URL
        }
        return BASE_URLS.get(self.config.provider)

    @property
    def is_openai_compatible(self) -> bool:
        """Check if this is using an OpenAI-compatible API."""
        return self.config.provider in [ModelProvider.OPENAI, ModelProvider.GOOGLE, ModelProvider.OTHERS]

    @property
    def is_anthropic(self) -> bool:
        """Check if this is an Anthropic model."""
        return self.config.provider == ModelProvider.ANTHROPIC

    @property
    def is_openai(self) -> bool:
        """Check if this is an OpenAI model."""
        return self.config.provider == ModelProvider.OPENAI

    @property
    def is_google(self) -> bool:
        """Check if this is a Google model."""
        return self.config.provider == ModelProvider.GOOGLE

    def process_image(self, figure_file: str, file_extension: str) -> tuple[str, str]:
        """Process image for models.

        Args:
            figure_file: Path to the image file
            file_extension: File extension (e.g. '.jpg', '.pdf')

        Returns:
            Tuple of (base64 encoded image data, media type)
        """
        img_data = get_base64_encoded_image(figure_file)
        ext = file_extension.lower()

        media_types = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".pdf": "application/pdf" if (self.capabilities.supports_native_pdf and count_pdf_pages(figure_file) > 1) else "image/png",
        }

        if ext not in media_types:
            raise ValueError(f"Unsupported file extension: {file_extension}")

        media_type = media_types[ext]
        if ext == ".pdf" and media_type == "image/png":
            img_data = process_pdf_input(figure_file)

        return img_data, media_type

    def create_image_message(self, figure_files: list[str]) -> list[dict]:
        """Create image messages for the conversation.

        This is a shared implementation that can be used by all providers.
        Individual providers can override if needed.
        """
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

    def check_stop_conditions(
        self,
        stop_reason: str,
        new_response: str,
        state_round: AgentStateRound,
        state_global: AgentStateGlobal,
        agent_settings: AgentSettings,
    ) -> tuple[bool, bool]:
        """Check if the conversation should stop and print debug info if stopping.

        Args:
            stop_reason: The reason for stopping from the model response
            new_response: The new response text
            state_round: The current round state
            state_global: The global conversation state
            agent_settings: The agent settings

        Returns:
            Tuple of (end_turn: bool, should_stop: bool)
        """
        output_token_limit = (
            self.config.output_token_limit_factor * state_global.first_input_tokens if state_global.first_input_tokens > 0 else float("inf")
        )

        end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
        encounter_document_tag = f"</{agent_settings.document_tag}>" in new_response
        continuation_limit = state_round.continuation_count > self.continue_limit
        input_token_limit = state_global.total_input_tokens > self.config.input_token_limit
        output_token_limit = state_global.total_output_tokens > output_token_limit

        if output_token_limit:
            logger.warning(f"Output tokens exceed {self.config.output_token_limit_factor}x input tokens")
            logger.warning(f"Total output tokens: {state_global.total_output_tokens}, " f"First input tokens: {state_global.first_input_tokens}")

        should_stop = encounter_document_tag or continuation_limit or input_token_limit

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
        """Create a response using the model's API."""
        pass

    @abstractmethod
    def initialize_messages(
        self,
        user_prefix: str,
        user_request: str,
        figure_files: list[str] | None = None,
        system_prompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def create_reflection_message(
        self,
        messages: list[dict],
        user_message: str,
        figure_files: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message."""
        pass

    @abstractmethod
    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for the model."""
        pass

    @abstractmethod
    def extract_response(
        self,
        response_object: Any,
        end_tag: str,
        auto_confirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics."""
        pass

    @abstractmethod
    def add_continue_message(
        self,
        messages: list[dict],
        state_round: AgentStateRound,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ) -> None:
        """Handle continuation for truncated responses."""
        pass

    @abstractmethod
    def initialize_output_and_prefill(
        self,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: list[dict],
        tool_state: ToolState,
        output_file: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill."""
        pass

    @abstractmethod
    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        pass

    @abstractmethod
    def compute_statistics(self, response_usage: Any, response_time: float) -> Any:
        """Compute model-specific statistics."""
        pass

    @abstractmethod
    def update_message_content(
        self,
        messages: list[dict],
        best_connector: str,
        new_response: str,
        tool_state: ToolState,
        auto_confirmation: bool = False,
    ) -> None:
        """Update message content."""
        pass

    @abstractmethod
    def should_continue(self, stop_reason: str, new_response: str, agent_settings: AgentSettings) -> bool:
        """Determine if the model should continue generating based on stop reason and response."""
        pass
