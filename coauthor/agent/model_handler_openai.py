"""OpenAI-specific model handlers."""

import os
from openai import OpenAI
from typing import Any

from ..logger import logger
from ..utils.file import read_file

from .model_handler import ModelHandler
from .model_config import ModelConfig
from .response_usage import OpenAIResponseUsage

from ..agent.agent_state import AgentStateRound
from ..agent import AgentSettings, AgentConfig
from .tool_handler import ToolState


class OpenAIHandler(ModelHandler):
    """OpenAI-specific handlers."""

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

        if self.config.name.lower() == "o1":
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
                # note that for openai native models, they have been renamed to "developer" but "system" still works
                messages.append({"role": "system", "content": system_prompt})

            # Create content list with user prefix
            content = [{"type": "text", "text": user_prefix}]

            # Add images if provided
            if figure_files:
                content.extend(self.create_image_message(figure_files))

            # Add user request
            request = {"type": "text", "text": user_request}
            content.append(request)

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

        def create_content_pair(image: dict) -> list[dict]:
            return [
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

        return [item for image in image_contents for item in create_content_pair(image)]

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
            logger.debug(response_object)
            raise ValueError(error_msg)

        # Extract base response
        choice = response_object.choices[0]
        stop_reason = choice.finish_reason
        new_response = choice.message.content.strip()

        # Add end tag if response was stopped and tag isn't present
        if all([stop_reason == "stop", end_tag]) and end_tag not in new_response:
            new_response = f"{new_response}\n{end_tag}"

        return new_response, response_object.usage, stop_reason

    def add_continue_message(
        self,
        messages: list[dict],
        state_round: AgentStateRound,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ) -> None:
        """Handle continuation for OpenAI models."""
        # Skip if model supports assistant prefill
        if self.config.capabilities.supports_assistant_prefill:
            logger.debug("Skipping continuation - assistant prefill is supported")
            return

        # Create continuation message with last K tokens
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
            if agent_config.tool_config.use_prefill_from_input and tool_state.first_k_chars_from_input:
                prefill += tool_state.first_k_chars_from_input
                tool_state.update_accumulated_output("")
                prefill = f"<{agent_settings.document_tag}>{tool_state.first_k_chars_from_input}"

            messages[-1]["content"].append({"type": "text", "text": f"Start your response with\n{prefill}"})
            return False, messages

        file_content = read_file(output_file)
        messages.append({"role": "assistant", "content": file_content})

        if agent_settings.has_end_tag(file_content):
            logger.debug("End tag detected - skipping continuation")
            if isinstance(messages[-1]["content"], list):
                messages[-1]["content"][-1]["text"] = file_content
            else:
                messages[-1]["content"] = file_content
            return True, messages

        logger.warning("Output file exists but no end tag found - continuing from file")
        tool_state.update_accumulated_output(file_content)
        state = AgentStateRound.initialize(0)
        tool_state.last_response = tool_state.accumulated_output
        self.add_continue_message(messages, state, tool_state, agent_settings, agent_config)

        # here state is somehow not possible to be passed outside?
        # also here continue message is added here, not like later it was handled separately. We should make them consistent...
        return False, messages

    def compute_price(self, response_usage: Any) -> float:
        """Compute price for OpenAI token usage."""
        # Handle Google models that return None for usage
        if response_usage is None:
            return 0.0

        # Get token counts with defaults for Google models
        prompt_tokens = getattr(response_usage, "prompt_tokens", 0)
        completion_tokens = getattr(response_usage, "completion_tokens", 0)

        base_price = (prompt_tokens * self.config.input_price + completion_tokens * self.config.output_price) / 1e6

        # Handle special token types
        if hasattr(response_usage, "reasoning_tokens"):
            base_price += (response_usage.reasoning_tokens * self.config.output_price) / 1e6
        if hasattr(response_usage, "cached_tokens"):
            base_price -= (response_usage.cached_tokens * self.config.input_price * 0.5) / 1e6

        return base_price

    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage:
        """Compute OpenAI-specific statistics."""
        # For Google models, create a minimal usage object with zeros
        if response_usage is None:
            return OpenAIResponseUsage.from_response(
                type(
                    "EmptyUsage",
                    (),
                    {
                        "prompt_tokens": 0,
                        "completion_tokens": 0,
                        "prompt_tokens_details": type("Details", (), {"cached_tokens": 0})(),
                        "completion_tokens_details": type(
                            "Details", (), {"reasoning_tokens": 0, "accepted_prediction_tokens": None, "rejected_prediction_tokens": None}
                        )(),
                    },
                )(),
                self.compute_price(response_usage),
                response_time,
            )

        return OpenAIResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(
        self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState, auto_confirmation: bool = False
    ) -> None:
        """Update message content for OpenAI models."""
        logger.debug("Updating message content for OpenAI API compatible models")

        # for OpenAI models (or models that do not support assistant prefill) the last message is always a user message
        if messages[-1]["role"] == "user":
            logger.debug("Last message is a user message")
            if "Your response got cut off" in messages[-1]["content"]:
                # the second last message is an assistant message must be a assistant message
                if messages[-2]["role"] == "assistant":
                    if isinstance(messages[-2]["content"], list):
                        messages[-2]["content"].append({"type": "text", "text": best_connector + new_response})
                    else:
                        logger.error("Second last message content is not a list")
                        messages[-2]["content"] = tool_state.accumulated_output
                    # Remove continuation prompt
                    messages.pop()
            else:
                logger.debug("Last message is a request message rather than a ask to continue after cut off")
                # otherwise last message is a request message rather than a ask to continue after cut off
                messages.append({"role": "assistant", "content": [{"type": "text", "text": tool_state.accumulated_output}]})

    def should_continue(self, stop_reason: str, new_response: str, agent_settings: AgentSettings) -> bool:
        """Determine if OpenAI model should continue generating."""
        logger.info("Determining if should continue for OpenAI model via OpenAI API")
        return stop_reason == "length" and not agent_settings.has_end_tag(new_response)
