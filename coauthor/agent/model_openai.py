"""OpenAI-compatible model configuration."""

import os
from dataclasses import dataclass
from typing import Any
from openai import OpenAI

from ..agent import AgentSettings, AgentConfig
from ..agent.agent_state import AgentRoundState
from ..utils.file import read_file
from ..logger import logger

from .model_base import ModelHandler, ModelProvider
from .response_usage import OpenAIResponseUsage


@dataclass
class OpenAIModelHandler(ModelHandler):
    """Configuration for OpenAI models."""

    provider: ModelProvider = ModelProvider.OPENAI

    def get_client(self):
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
        """Create a response using the appropriate API call for this model."""
        kwargs = {
            "model": self.full_name,
            "messages": messages,
            "temperature": temperature,
            # For openai model, this value is now in favor of max_tokens, and max_tokens not compatible with o1 series models.
            "max_completion_tokens": self.max_output_tokens,
        }

        if "o1" in self.name:
            kwargs["temperature"] = 1.0
        else:
            kwargs["stop"] = end_tag

        if self.is_openrouter:
            kwargs["extra_headers"] = {"X-Title": "CoA"}

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
        content = []
        for image in image_contents:
            content.extend(
                [
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
            )
        return content

    def extract_response(self, response_object, end_tag: str, auto_confirmation: bool = False) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from OpenAI response object."""
        if not response_object or not response_object.choices:
            logger.error("Invalid response object")
            raise ValueError("Invalid response from API")

        # Extract response content and stop reason
        choice = response_object.choices[0]
        stop_reason = choice.finish_reason
        new_response = choice.message.content.strip()

        # Add end tag if needed
        if stop_reason == "stop" and end_tag and end_tag not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, response_object.usage, stop_reason

    def handle_continuation(
        self,
        messages: list[dict],
        round_state: AgentRoundState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for OpenAI-compatible models."""
        if self.capabilities.supports_assistant_prefill:
            # no user message needs to be added if assistant prefill is supported
            pass
        else:
            prefill_tokens = round_state.last_response[-agent_config.K :]
            user_message_continuation = (
                f"Your response got cut off, because you only have limited response space. "
                f"Continue writing exactly from where you left off until the very end, "
                f"marked by {agent_settings.end_tag}. "
                "Avoid repeat yourself and avoid starting over. "
                f'Start your response at the next token after: "{prefill_tokens}"'
            )
            logger.info("Adding User message:")
            logger.debug(user_message_continuation)
            messages.append({"role": "user", "content": [{"type": "text", "text": user_message_continuation}]})

    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: list[dict],
        prefill: str,
        accumulated_output: str,
        first_k_tex_document: str | None = None,
    ) -> tuple[str, bool, list[dict]]:
        """Initialize output and handle prefill for OpenAI-compatible models."""
        if os.path.exists(output_file) and os.path.getsize(output_file) > 15:
            # try to get prefill from existing file
            file_content = read_file(output_file)
            if agent_settings.has_end_tag(file_content):
                logger.debug("End tag detected - skipping continuation")
                messages.append({"role": "assistant", "content": file_content})
                return None, True, messages
            else:
                logger.warning("Output file exists but no end tag found - continuing from file")
                accumulated_output = file_content
                messages.append({"role": "assistant", "content": file_content})
                logger.debug(f"Using existing content as prefill: {output_file}")
                state = AgentRoundState.initialize(0, accumulated_output)
                self.handle_continuation(messages, state, agent_settings, agent_config)
        else:
            if agent_config.use_prefill_from_input and first_k_tex_document:
                prefill += first_k_tex_document
                accumulated_output = ""

                if agent_settings.output_ext == "tex" and first_k_tex_document:
                    prefill = f"<latex_document>{first_k_tex_document}"

            openai_prefill = f"Start your response with\n{prefill}"
            # this assumes that the last message is a user message
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})

        return accumulated_output, False, messages

    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        total_input_tokens = response_usage.prompt_tokens
        total_output_tokens = response_usage.completion_tokens

        # Apply adjustments for caching and reasoning
        if hasattr(response_usage, "reasoning_tokens"):
            total_output_tokens += response_usage.reasoning_tokens
        if hasattr(response_usage, "cached_tokens"):
            total_input_tokens -= response_usage.cached_tokens * 0.5

        return (total_input_tokens * self.input_price + total_output_tokens * self.output_price) / 1e6

    def compute_statistics(self, response_usage: Any, response_time: float) -> OpenAIResponseUsage:
        """Compute model-specific statistics from response usage object."""
        return OpenAIResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, accumulated_output: str) -> None:
        """Update message content for OpenAI models."""
        logger.debug("Updating message content for OpenAI models")

        last_message = messages[-1]
        if self.capabilities.supports_assistant_prefill:
            # although OpenAI models do not support assistant prefill, some models via OpenRouter might do
            if last_message["role"] == "assistant":
                messages[-1]["content"] = accumulated_output
            elif last_message["role"] == "user":
                messages.append({"role": "assistant", "content": accumulated_output})
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
                    messages.append({"role": "assistant", "content": [{"type": "text", "text": accumulated_output}]})


class OpenAICompatibleModelHandler(OpenAIModelHandler):
    pass
