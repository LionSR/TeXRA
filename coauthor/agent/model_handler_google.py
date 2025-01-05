"""Handler for Google models using OpenAI-compatible API."""

from typing import Any
from openai import OpenAI

from ..logger import logger

from .model_handler_openai import OpenAIHandler
from .response_usage import OpenAIAPIResponseUsage


class GoogleviaOpenAIHandler(OpenAIHandler):
    """Handler for Google models using OpenAI-compatible API."""

    def getClient(self) -> OpenAI:
        """Get OpenAI client with Google's base URL."""
        api_key = self.get_api_key()
        base_url = self.get_base_url()
        logger.info(f"Using Google API key. Base URL: {base_url}")
        return OpenAI(
            api_key=api_key,
            base_url=base_url,
        )

    def compute_price(self, responseUsage: Any) -> float:
        """Compute price for Google token usage."""
        # Google models return completionTokens, promptTokens instead of completion_tokens, prompt_tokens
        prompt_tokens = getattr(responseUsage, "promptTokens", 0)
        completion_tokens = getattr(responseUsage, "completionTokens", 0)

        return (prompt_tokens * self.config.inputPrice + completion_tokens * self.config.outputPrice) / 1e6

    def computeResponseUsage(self, responseUsage: Any, responseTime: float) -> OpenAIAPIResponseUsage:
        """Compute statistics for Google models."""
        # Create a minimal usage object with Google's token counts
        usage_obj = type(
            "GoogleUsage",
            (),
            {
                "prompt_tokens": getattr(responseUsage, "promptTokens", 0),
                "completion_tokens": getattr(responseUsage, "completionTokens", 0),
                "total_tokens": getattr(responseUsage, "totalTokens", 0),
                "prompt_tokens_details": type("Details", (), {"cached_tokens": 0})(),
                "completion_tokens_details": type(
                    "Details", (), {"reasoning_tokens": 0, "accepted_prediction_tokens": None, "rejected_prediction_tokens": None}
                )(),
            },
        )()

        return OpenAIAPIResponseUsage.from_response(usage_obj, self.compute_price(responseUsage), responseTime)

    def should_continue(self, stopReason: str, newResponse: str, agentSetting) -> bool:
        """Determine if OpenAI model should continue generating."""
        logger.info("Determining if should continue for Google model via OpenAI API")
        return not agentSetting.has_endTag(newResponse)
