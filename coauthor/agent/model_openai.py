"""OpenAI-compatible model configuration."""

import os
from dataclasses import dataclass
from typing import Any
from openai import OpenAI

from ..logger import logger
from ..agent import AgentSettings, AgentConfig
from ..agent.agent_state import AgentRoundState
from ..utils.file import read_file

from .tool_handler import ToolState
from .model_base import ModelHandler, ModelProvider
from .response_usage import OpenAIResponseUsage


@dataclass
class OpenAIModelHandler(ModelHandler):
    """Configuration for OpenAI models."""

    provider: ModelProvider = ModelProvider.OPENAI

    def get_client(self) -> OpenAI:
        """Get the appropriate client for this model."""
        api_key = self.provider.get_api_key()
        base_url = self.provider.get_base_url()
        return OpenAI(api_key=api_key, base_url=base_url)

    def create_response(
        self,
        client: OpenAI,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = None,
        end_tag: str | None = None,
    ) -> Any:
        """Create a response using the OpenAI API."""
        base_kwargs = {
            "model": self.full_name,
            "messages": messages,
            "max_completion_tokens": self.max_output_tokens,
        }

        kwargs = {
            **base_kwargs,
            "temperature": 1.0 if "o1" in self.name else temperature,
            **({"stop": end_tag} if end_tag and "o1" not in self.name else {}),
            **({"extra_headers": {"X-Title": "CoA"}} if self.is_openrouter else {}),
        }

        return client.chat.completions.create(**kwargs)

    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: str | None = None) -> list[dict]:
        """Initialize messages for the conversation."""
        if "o1" in self.name:
            messages = [{"role": "user", "content": [{"type": "text", "text": system_prompt}, {"type": "text", "text": user_prefix}]}]
        else:
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

        if figure_files:
            image_content = self.create_image_message(figure_files)
            messages[-1]["content"].extend(image_content)

        messages[-1]["content"].append({"type": "text", "text": user_request})
        return messages

    def create_reflection_message(self, messages: list[dict], user_message: str, figure_files=None) -> list[dict]:
        """Create a reflection message for OpenAI-compatible models."""
        content = []

        if figure_files:
            image_content = self.create_image_message(figure_files)
            content.extend(image_content)

        content.append({"type": "text", "text": user_message})

        messages.append({"role": "user", "content": content})
        return messages

    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for OpenAI-compatible models."""
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

    def extract_response(self, response_object, end_tag: str, auto_confirmation: bool = False) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from OpenAI response object."""
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

    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        # Calculate base price from input and output tokens
        base_price = (response_usage.prompt_tokens * self.input_price + response_usage.completion_tokens * self.output_price) / 1e6

        # Apply adjustments for additional features
        if hasattr(response_usage, "reasoning_tokens"):
            base_price += (response_usage.reasoning_tokens * self.output_price) / 1e6
        if hasattr(response_usage, "cached_tokens"):
            base_price -= (response_usage.cached_tokens * self.input_price * 0.5) / 1e6

        return base_price

    def handle_continuation(
        self,
        messages: list[dict],
        round_state: AgentRoundState,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for OpenAI-compatible models."""
        if self.capabilities.supports_assistant_prefill:
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
        messages.append(
            {
                "role": "user",
                "content": [{"type": "text", "text": user_message_continuation}],
            }
        )

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
            self._handle_new_output(messages, agent_config, agent_settings, tool_state, prefill)
            return False, messages

        file_content = read_file(output_file).strip()
        messages.append({"role": "assistant", "content": file_content})

        if agent_settings.has_end_tag(file_content):
            return True, messages

        # Continue from existing file
        logger.warning("Output file exists but no end tag found - continuing from file")
        tool_state.update_accumulated_output(file_content)

        state = AgentRoundState.initialize(0)
        tool_state.last_response = tool_state.accumulated_output
        self.handle_continuation(messages, state, tool_state, agent_settings, agent_config)
        return False, messages

    def _handle_new_output(self, messages: list[dict], agent_config: AgentConfig, agent_settings: AgentSettings, tool_state: ToolState, prefill: str):
        """Helper method to handle new output initialization."""
        if agent_config.use_prefill_from_input and tool_state.first_k_tex_document:
            prefill += tool_state.first_k_tex_document
            tool_state.update_accumulated_output("")

            if agent_settings.output_ext == "tex" and tool_state.first_k_tex_document:
                prefill = f"<latex_document>{tool_state.first_k_tex_document}"

        messages[-1]["content"].append({"type": "text", "text": f"Start your response with\n{prefill}"})

    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage:
        """Compute model-specific statistics from response usage object."""
        return OpenAIResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState) -> None:
        """Update message content for OpenAI models."""
        logger.debug("Updating message content for OpenAI models")

        last_message = messages[-1]
        if self.capabilities.supports_assistant_prefill:
            # although OpenAI models do not support assistant prefill, some models via OpenRouter might do
            if last_message["role"] == "assistant":
                messages[-1]["content"] = tool_state.accumulated_output
            elif last_message["role"] == "user":
                messages.append({"role": "assistant", "content": tool_state.accumulated_output})
            pass
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


class OpenAICompatibleModelHandler(OpenAIModelHandler):
    pass
