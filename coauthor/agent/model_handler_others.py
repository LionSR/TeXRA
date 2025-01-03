"""Handlers for various models using OpenAI-compatible APIs."""

from typing import Any
from openai import OpenAI

from ..logger import logger

from .model_handler_openai import OpenAIHandler
from .tool_handler import ToolState
from .response_usage import OpenAIResponseUsage


class GoogleviaOpenAIHandler(OpenAIHandler):
    """Handler for Google models using OpenAI-compatible API."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with Google's base URL."""
        return OpenAI(
            api_key=self.get_api_key(),
            base_url=self.get_base_url(),
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
        return not agent_settings.has_end_tag(new_response)


class OpenRouterHandler(OpenAIHandler):
    """Handler for models accessed through OpenRouter."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with OpenRouter configuration."""
        return OpenAI(
            api_key=self.get_api_key(),
            base_url=self.get_base_url(),
        )

    def create_response(
        self,
        client: OpenAI,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = None,
        end_tag: str | None = None,
    ) -> Any:
        """Create a response using OpenRouter's API."""
        kwargs = {
            "model": self.config.openrouter_full_name,  # Use OpenRouter model name
            "messages": messages,
            "max_tokens": self.config.max_output_tokens,
            "temperature": temperature,
            "extra_headers": {"X-Title": "CoA"},
        }

        if end_tag:
            kwargs["stop"] = [end_tag]

        return client.chat.completions.create(**kwargs)


class AnthropicviaOpenrouterHandler(OpenRouterHandler):
    """Handler for Anthropic models using OpenAI-compatible API via OpenRouter."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with Google's base URL."""
        return OpenAI(
            api_key=self.get_api_key(),
            base_url=self.get_base_url(),
        )

    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState) -> None:
        last_message = messages[-1]
        if self.config.capabilities.supports_assistant_prefill:
            # although OpenAI models do not support assistant prefill, some models (such as Anthropic) via OpenRouter might do
            if last_message["role"] == "assistant":
                if isinstance(messages[-1]["content"], list):
                    messages[-1]["content"][-1]["text"] = best_connector + new_response
                elif isinstance(messages[-1]["content"], str):
                    messages[-1]["content"] = tool_state.accumulated_output
            elif last_message["role"] == "user":
                messages.append({"role": "assistant", "content": tool_state.accumulated_output})
