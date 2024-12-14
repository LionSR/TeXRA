"""Base model configuration classes and types."""

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Any, Tuple

from ..agent_dataclass import AgentSettings, AgentConfig
from ..state import State
from ..logging_utils import logger
from ..img_utils import get_base64_encoded_image, page_count_pdf, process_pdf_input


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

    def get_base_url(self) -> Optional[str]:
        """Get base URL for API requests."""
        urls = {
            self.OPENROUTER: "https://openrouter.ai/api/v1",
            self.GOOGLE: "https://generativelanguage.googleapis.com/v1beta",
            self.OPENAI: None,
        }
        return urls.get(self)


@dataclass
class ModelConfig(ABC):
    """Base class for model configurations."""

    name: str  # Short name (e.g., "sonnet++")
    full_name: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    max_tokens: int
    input_price: float
    output_price: float
    provider: ModelProvider
    context_window: int = 128000
    supports_prompt_caching: bool = False
    supports_reasoning: bool = False
    supports_vision: bool = True
    supports_native_pdf: bool = False
    supports_assistant_prefill: bool = False
    supports_predictive_output: bool = False
    likes_to_ask_for_confirmation: bool = False
    base_url: Optional[str] = None

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
        messages: List[Dict],
        temperature: float,
        system_prompt: Optional[str] = None,
        end_tag: Optional[str] = None,
    ) -> Any:
        """Create a response using the appropriate API call for this model."""
        pass

    @abstractmethod
    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: Optional[str] = None) -> List[Dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def create_reflection_message(self, messages: List[Dict], user_message: str, figure_files=None) -> List[Dict]:
        """Create a reflection message and handle prompt caching."""
        pass

    @abstractmethod
    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for the model."""
        pass

    @abstractmethod
    def extract_response_statistics(self, response_object, end_tag: str) -> Tuple[str, int, int, str]:
        """Extract statistics from the response object.
        Returns: (new_response, input_tokens, output_tokens, stop_reason)
        """
        pass

    def process_image(self, figure_file: str, file_extension: str):
        """Process image for Anthropic models."""
        img_data = get_base64_encoded_image(figure_file)
        if file_extension.lower() in [".jpg", ".jpeg"]:
            media_type = "image/jpeg"
        elif file_extension.lower() == ".png":
            media_type = "image/png"
        elif file_extension.lower() == ".pdf":
            # For PDFs, use native PDF support if available and multi-page
            if self.supports_native_pdf and page_count_pdf(figure_file) > 1:
                media_type = "application/pdf"
            else:
                img_data = process_pdf_input(figure_file)
                media_type = "image/png"

        return img_data, media_type

    @abstractmethod
    def handle_continuation(
        self,
        messages: List[Dict],
        state: State,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for a model when response is truncated."""
        pass

    @abstractmethod
    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: List[Dict],
        prefill: str,
        accumulated_output: str,
        first_k_tex_document: Optional[str] = None,
    ) -> Tuple[str, bool, List[Dict]]:
        """Initialize output and handle prefill based on model requirements."""
        pass

    def compute_price(
        self,
        input_tokens: int,
        output_tokens: int,
        # for openai models with prompt caching support
        cache_tokens: Optional[int] = None,
        # for openai models with reasoning tokens support
        reasoning_tokens: Optional[int] = None,
        # for anthropic models with prompt caching support
        cache_creation_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
    ) -> float:
        """
        Compute the price for token usage.
        In the future this should just take response_object.usage as input.
        """
        return (input_tokens * self.input_price + output_tokens * self.output_price) / 1e6

    def check_stop_conditions(
        self, stop_reason: str, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool
    ) -> tuple[bool, bool]:
        """Check if the conversation should stop."""
        CONTINUE_LIMIT = 20 if self.likes_to_ask_for_confirmation else 10
        INPUT_TOKEN_LIMIT = 1500000
        OUTPUT_TOKEN_LIMIT_FACTOR = 2.5

        end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
        encounter_document_tag = f"</{agent_settings.document_tag}>" in new_response
        continuation_limit = state.continuation_count > CONTINUE_LIMIT
        input_token_limit = state.total_input_tokens > INPUT_TOKEN_LIMIT
        output_token_limit = state.total_output_tokens > OUTPUT_TOKEN_LIMIT_FACTOR * state.first_input_tokens

        if output_token_limit:
            logger.error(f"Output tokens exceed {OUTPUT_TOKEN_LIMIT_FACTOR}x input tokens - halting process")

        should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

        return end_turn, should_stop

    def print_stop_flags(self, end_turn: bool, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool):
        """Print the flags indicating why the conversation stopped."""

        CONTINUE_LIMIT = 20 if self.likes_to_ask_for_confirmation else 10
        INPUT_TOKEN_LIMIT = 100000
        OUTPUT_TOKEN_LIMIT_FACTOR = 2.5

        logger.debug(
            f"Stop flags:\n"
            f"end_turn: {end_turn}\n"
            f"encounter_document_tag: {'</'+agent_settings.document_tag+'>' in new_response}\n"
            f"continuation_limit: {state.continuation_count > CONTINUE_LIMIT}\n"
            f"input_token_limit: {state.total_input_tokens > INPUT_TOKEN_LIMIT}\n"
            f"massive_repetition_detected: {massive_repetition_detected}\n"
            f"output_token_limit: {state.total_output_tokens > OUTPUT_TOKEN_LIMIT_FACTOR * state.first_input_tokens}\n"
        )

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
                # Use model-specific image processing
                img_data, media_type = self.process_image(figure_file, file_extension)
                logger.debug(f"Processed image: {figure_file}, type: {media_type}")

                # Handle multi-page PDFs
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
