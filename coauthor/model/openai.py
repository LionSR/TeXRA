"""OpenAI-compatible model configuration."""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Any, Tuple
from openai import OpenAI

from .model_base import ModelConfig, ModelProvider

from ..agent import AgentSettings, AgentConfig, AgentState
from ..utils.file import read_file
from ..logger import logger


@dataclass
class OpenAIModelConfig(ModelConfig):
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
        messages: List[Dict],
        temperature: float,
        system_prompt: Optional[str] = None,
        end_tag: Optional[str] = None,
    ) -> Any:
        """Create a response using the appropriate API call for this model."""
        kwargs = {
            "model": self.full_name,
            "messages": messages,
            "temperature": temperature,
            # For openai model, this value is now in favor of max_tokens, and max_tokens not compatible with o1 series models.
            "max_completion_tokens": self.max_tokens,
        }

        if "o1" in self.name:
            kwargs["temperature"] = 1.0
        else:
            kwargs["stop"] = end_tag

        if self.is_openrouter:
            kwargs["extra_headers"] = {"X-Title": "CoA"}

        return client.chat.completions.create(**kwargs)

    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: Optional[str] = None) -> List[Dict]:
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

    def create_reflection_message(self, messages: List[Dict], user_message: str, figure_files=None) -> List[Dict]:
        """Create a reflection message for OpenAI-compatible models."""
        content = []

        if figure_files:
            image_content = self.create_image_message(figure_files)
            content.extend(image_content)

        content.append({"type": "text", "text": user_message})

        messages.append({"role": "user", "content": content})
        return messages

    def create_image_content(self, image_contents: list) -> List[Dict]:
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

    def extract_response_statistics(self, response_object, end_tag: str) -> Tuple[str, int, int, str]:
        """
        Extract statistics from OpenAI response object.
        finish_reason: The reason the model stopped generating tokens.
        This will be "stop" if the model hit a natural stop point or a provided stop sequence,
        "length" if the maximum number of tokens specified in the request was reached,
        "content_filter" if content was omitted due to a flag from our content filters,
        "tool_calls" if the model called a tool, or "function_call" (deprecated) if the model called a function.
        """
        # this function needs to be split
        # one part for statistics
        # one part for response extraction
        if not response_object or not response_object.choices:
            logger.error("Invalid response object")
            raise ValueError("Invalid response from API")

        # Extract response content and stop reason
        choice = response_object.choices[0]
        stop_reason = choice.finish_reason
        new_response = choice.message.content.strip()

        # Get usage statistics
        usage = getattr(response_object, "usage", None)
        if usage is None:
            logger.warning("No usage information in response")
            input_tokens = output_tokens = 0
        else:
            input_tokens = usage.prompt_tokens
            output_tokens = usage.completion_tokens
            # for openai models, we can get more detailed usage information
            # cached_tokens = response_usage.prompt_tokens_details.cached_tokens
            # reasoning_tokens = response_usage.completion_tokens_details.reasoning_tokens
            # accepted_prediction_tokens = response_usage.completion_tokens_details.accepted_prediction_tokens
            # rejected_prediction_tokens = response_usage.completion_tokens_details.rejected_prediction_tokens

        # maybe in some cases, we need to use \\end{document} instead of end_tag
        # Add end tag if needed
        if stop_reason == "stop" and end_tag and end_tag not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, input_tokens, output_tokens, stop_reason

    def handle_continuation(
        self,
        messages: List[Dict],
        state: AgentState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for OpenAI-compatible models."""
        prefill_tokens = state.last_response[-agent_config.K :]
        user_message_continuation = (
            f"Your response got cut off, because you only have limited response space. "
            f"Continue writing exactly from where you left off until the very end, "
            f"marked by {agent_settings.end_tag}. "
            "Avoid repeat yourself and avoid starting over. "
            f'Start your response at the next token after: "{prefill_tokens}"'
        )
        logger.info("User message: " + user_message_continuation)
        messages.append({"role": "user", "content": user_message_continuation})

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
                state = AgentState.initialize(accumulated_output)
                self.handle_continuation(messages, state, agent_settings, agent_config)
        else:
            if agent_config.use_prefill_from_input and first_k_tex_document:
                prefill += first_k_tex_document
                accumulated_output = ""

                if agent_settings.output_ext == "tex" and first_k_tex_document:
                    prefill = f"<latex_document>{first_k_tex_document}"

            openai_prefill = f"Start your response with\n{prefill}"
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})

        return accumulated_output, False, messages

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
        Compute the price for token usage for OpenAI-compatible models.
        In the future this should just take response_object.usage as input.
        """
        total_input_tokens = input_tokens
        total_output_tokens = output_tokens
        if reasoning_tokens:
            total_output_tokens += reasoning_tokens
        if cache_tokens:
            total_input_tokens -= cache_tokens * 0.5

        return (total_input_tokens * self.input_price + total_output_tokens * self.output_price) / 1e6


class OpenAICompatibleModelConfig(OpenAIModelConfig):
    pass
