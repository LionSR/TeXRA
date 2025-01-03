"""Handlers for models accessed through OpenRouter."""

from typing import Any
from openai import OpenAI

from .model_handler_openai import OpenAIHandler
from .tool_state import ToolState

from ..logger import logger


class OpenRouterHandler(OpenAIHandler):
    """Handler for models accessed through OpenRouter."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with OpenRouter configuration."""
        api_key = self.get_api_key()
        baseUrl = self.get_baseUrl()
        logger.info(f"Using OpenRouter API key. Base URL: {baseUrl}")
        return OpenAI(
            api_key=api_key,
            baseUrl=baseUrl,
        )

    def create_response(
        self,
        client: OpenAI,
        messages: list[dict],
        temperature: float,
        systemPrompt: str | None = None,
        endTag: str | None = None,
    ) -> Any:
        """Create a response using OpenRouter's API."""
        kwargs = {
            "model": self.config.openrouterFullName,  # Use OpenRouter model name
            "messages": messages,
            "max_tokens": self.config.maxOutputTokens,
            "temperature": temperature,
            "extra_headers": {"X-Title": "CoA"},
        }

        if endTag:
            kwargs["stop"] = [endTag]

        return client.chat.completions.create(**kwargs)


class AnthropicviaOpenrouterHandler(OpenRouterHandler):
    """Handler for Anthropic models using OpenAI-compatible API via OpenRouter."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with Anthropic's base URL."""
        return OpenAI(
            api_key=self.get_api_key(),
            baseUrl=self.get_baseUrl(),
        )

    def update_message_content(self, messages: list[dict], bestConnector: str, newResponse: str, toolState: ToolState) -> None:
        last_message = messages[-1]
        if self.capabilities.supportsAssistantPrefill:
            # although OpenAI models do not support assistant prefill, some models (such as Anthropic) via OpenRouter might do
            if last_message["role"] == "assistant":
                if isinstance(messages[-1]["content"], list):
                    messages[-1]["content"][-1]["text"] = bestConnector + newResponse
                elif isinstance(messages[-1]["content"], str):
                    messages[-1]["content"] = toolState.accumulatedOutput
            elif last_message["role"] == "user":
                messages.append({"role": "assistant", "content": toolState.accumulatedOutput})
