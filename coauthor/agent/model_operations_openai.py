"""OpenAI-specific model operations."""

import os
from openai import OpenAI
from typing import Any

from ..logger import logger
from ..utils.file import read_file

from .model_operations import ModelOperations
from .model_config import ModelConfig
from .response_usage import OpenAIResponseUsage

from ..agent.agent_state import AgentRoundState
from ..agent import AgentSettings, AgentConfig
from .tool_handler import ToolState


class OpenAIOperations(ModelOperations):
    """OpenAI-specific operations."""

    def __init__(self, config: ModelConfig):
        super().__init__(config)

    def get_client(self) -> OpenAI:
        """Get OpenAI client."""
        return OpenAI(api_key=self.config.get_api_key())

    def create_response(
        self,
        client: OpenAI,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = None,
        end_tag: str | None = None,
    ) -> Any:
        """Create a response using OpenAI's API."""
        kwargs = {
            "model": self.config.full_name,
            "messages": messages,
            "max_completion_tokens": self.config.max_output_tokens,
            "temperature": 1.0 if "o1" in self.config.name.lower() else temperature,
        }

        if end_tag and "o1" not in self.config.name.lower():
            kwargs["stop"] = [end_tag]

        if "o1" in self.config.name.lower():
            kwargs["reasoning_effort"] = "high"

        return client.chat.completions.create(**kwargs)

    def initialize_messages(
        self,
        user_prefix: str,
        user_request: str,
        figure_files: list[str] | None = None,
        system_prompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for OpenAI models."""
        messages = []

        # Handle system prompt differently for O1 models
        if self.config.name in ["o1-", "o1preview"]:
            messages = [{"role": "user", "content": [{"type": "text", "text": system_prompt}, {"type": "text", "text": user_prefix}]}]
        else:
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            content = [{"type": "text", "text": user_prefix}]
            if figure_files:
                content.extend(self.create_image_message(figure_files))
            content.append({"type": "text", "text": user_request})
            messages.append({"role": "user", "content": content})

        return messages

    def create_reflection_message(
        self,
        messages: list[dict],
        user_message: str,
        figure_files: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message for OpenAI models."""
        content = []

        if figure_files:
            content.extend(self.create_image_message(figure_files))
        content.append({"type": "text", "text": user_message})
        messages.append({"role": "user", "content": content})
        return messages

    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for OpenAI models."""
        return [
            item
            for image in image_contents
            for item in [
                {"type": "text", "text": f"Image: {image['file_name']}"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image['media_type']};base64,{image['data']}",
                        "media_type": image["media_type"],
                        "data": image["data"],
                    },
                },
            ]
        ]

    def extract_response(
        self,
        response_object: Any,
        end_tag: str,
        auto_confirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from OpenAI response."""
        if not (hasattr(response_object, "choices") and response_object.choices):
            error_msg = "Invalid response from API: missing choices"
            logger.error(error_msg)
            raise ValueError(error_msg)

        # Extract base response
        choice = response_object.choices[0]
        stop_reason = choice.finish_reason
        new_response = choice.message.content.strip()

        # Add end tag if response was stopped and tag isn't present
        if all([stop_reason == "stop", end_tag]) and end_tag not in new_response:
            new_response = f"{new_response}\n{end_tag}"

        return new_response, response_object.usage, stop_reason

    def handle_continuation(
        self,
        messages: list[dict],
        round_state: AgentRoundState,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ) -> None:
        """Handle continuation for OpenAI models."""
        if self.config.capabilities.supports_assistant_prefill:
            logger.debug("Skipping continuation - assistant prefill is supported")
            return

        # Create continuation message
        prefill_tokens = tool_state.last_response[-agent_config.K :]
        user_message_continuation = (
            f"Your response got cut off, because you only have limited response space. "
            f"Continue writing exactly from where you left off until the very end, "
            f"marked by {agent_settings.end_tag}. "
            "Avoid repeat yourself and avoid starting over. "
            f'Start your response at the next token after: "{prefill_tokens}"'
        )

        # Add continuation message
        logger.info("Adding continuation message to conversation")
        logger.debug(f"Continuation message: {user_message_continuation}")
        messages.append({"role": "user", "content": [{"type": "text", "text": user_message_continuation}]})

    def initialize_output_and_prefill(
        self,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: list[dict],
        tool_state: ToolState,
        output_file: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill for OpenAI-compatible models."""
        if not os.path.exists(output_file) or os.path.getsize(output_file) <= 15:
            if agent_config.tool_config.use_prefill_from_input and tool_state.first_k_tex_document:
                prefill += tool_state.first_k_tex_document
                tool_state.update_accumulated_output("")
                if agent_settings.output_ext == "tex":
                    prefill = f"<latex_document>{tool_state.first_k_tex_document}"
            messages[-1]["content"].append({"type": "text", "text": f"Start your response with\n{prefill}"})
            return False, messages

        file_content = read_file(output_file).strip()
        messages.append({"role": "assistant", "content": file_content})

        if agent_settings.has_end_tag(file_content):
            return True, messages

        logger.warning("Output file exists but no end tag found - continuing from file")
        tool_state.update_accumulated_output(file_content)
        state = AgentRoundState.initialize(0)
        tool_state.last_response = tool_state.accumulated_output
        self.handle_continuation(messages, state, tool_state, agent_settings, agent_config)
        return False, messages

    def compute_price(self, response_usage: Any) -> float:
        """Compute price for OpenAI token usage."""
        base_price = (response_usage.prompt_tokens * self.config.input_price + response_usage.completion_tokens * self.config.output_price) / 1e6

        # Handle special token types
        if hasattr(response_usage, "reasoning_tokens"):
            base_price += (response_usage.reasoning_tokens * self.config.output_price) / 1e6
        if hasattr(response_usage, "cached_tokens"):
            base_price -= (response_usage.cached_tokens * self.config.input_price * 0.5) / 1e6

        return base_price

    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage:
        """Compute OpenAI-specific statistics."""
        return OpenAIResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState) -> None:
        logger.debug("Updating message content for OpenAI models")

        last_message = messages[-1]
        if self.config.capabilities.supports_assistant_prefill:
            # although OpenAI models do not support assistant prefill, some models via OpenRouter might do
            if last_message["role"] == "assistant":
                messages[-1]["content"] = tool_state.accumulated_output
            elif last_message["role"] == "user":
                messages.append({"role": "assistant", "content": tool_state.accumulated_output})
        else:
            # for OpenAI models (or models that do not support assistant prefill) the last message is always a user message
            if last_message["role"] == "user":
                logger.debug("Last message is a user message")
                if "Your response got cut off" in last_message["content"]:
                    # the second last message is an assistant message must be a assistant message
                    if messages[-2]["role"] == "assistant":
                        if isinstance(messages[-2]["content"], list):
                            messages[-2]["content"].append({"type": "text", "text": best_connector + new_response})
                        else:
                            logger.error("Second last message content is not a list")
                            messages[-2]["content"] = best_connector + new_response
                        messages.pop()
                else:
                    logger.debug("Last message is a request message rather than a ask to continue after cut off")
                    # otherwise last message is a request message rather than a ask to continue after cut off
                    messages.append({"role": "assistant", "content": [{"type": "text", "text": tool_state.accumulated_output}]})


class OpenAICompatibleOperations(OpenAIOperations):
    """Operations for Google models using OpenAI-compatible API."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with Google's base URL."""
        return OpenAI(
            api_key=self.config.get_api_key(),
            base_url=self.config.get_base_url(),
        )


class OpenRouterOperations(OpenAIOperations):
    """Operations for models accessed through OpenRouter."""

    def get_client(self) -> OpenAI:
        """Get OpenAI client with OpenRouter configuration."""
        return OpenAI(
            api_key=self.config.get_api_key(),
            base_url=self.config.get_base_url(),
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
