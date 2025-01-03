"""Handler for Google models using OpenAI-compatible API."""

from typing import Any
from openai import OpenAI

from ..logger import logger

from .model_handler_openai import OpenAIHandler
from .response_usage import OpenAIResponseUsage


class GoogleviaOpenAIHandler(OpenAIHandler):
    """Handler for Google models using OpenAI-compatible API."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with Google's base URL."""
        api_key = self.get_api_key()
        base_url = self.get_base_url()
        logger.info(f"Using Google API key. Base URL: {base_url}")
        return OpenAI(
            api_key=api_key,
            base_url=base_url,
        )

    def compute_price(self, response_usage: Any) -> float:
        """Compute price for Google token usage."""
        # Google models return completionTokens, promptTokens instead of completion_tokens, prompt_tokens
        prompt_tokens = getattr(response_usage, "promptTokens", 0)
        completion_tokens = getattr(response_usage, "completionTokens", 0)

        return (prompt_tokens * self.config.input_price + completion_tokens * self.config.output_price) / 1e6

    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage:
        """Compute statistics for Google models."""
        # Create a minimal usage object with Google's token counts
        usage_obj = type(
            "GoogleUsage",
            (),
            {
                "prompt_tokens": getattr(response_usage, "promptTokens", 0),
                "completion_tokens": getattr(response_usage, "completionTokens", 0),
                "total_tokens": getattr(response_usage, "totalTokens", 0),
                "prompt_tokens_details": type("Details", (), {"cached_tokens": 0})(),
                "completion_tokens_details": type(
                    "Details", (), {"reasoning_tokens": 0, "accepted_prediction_tokens": None, "rejected_prediction_tokens": None}
                )(),
            },
        )()

        return OpenAIResponseUsage.from_response(usage_obj, self.compute_price(response_usage), response_time)

    def should_continue(self, stop_reason: str, new_response: str, agent_settings) -> bool:
        """Determine if OpenAI model should continue generating."""
        logger.info("Determining if should continue for Google model via OpenAI API")
        return not agent_settings.has_endTag(new_response)
