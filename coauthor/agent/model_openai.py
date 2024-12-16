"""OpenAI-compatible model configuration."""

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Any, Tuple
from openai import OpenAI


from ..agent import AgentSettings, AgentConfig, AgentState
from ..utils.file import read_file
from ..logger import logger

from .model_base import ModelConfig, ModelProvider
from .response_usage import ResponseUsageBase, OpenAIResponseUsage


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
            "max_completion_tokens": self.max_output_tokens,
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

    def extract_response(self, response_object, end_tag: str) -> Tuple[str, Any, str]:
        """
        Extract response text and usage statistics from OpenAI response object.
        Returns:
            Tuple containing:
            - response text (str)
            - response usage object (Any)
            - stop reason (str)
        """
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
        messages: List[Dict],
        state: AgentState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ):
        """Handle continuation for OpenAI-compatible models."""
        if self.capabilities.supports_assistant_prefill:
            # no user message needs to be added if assistant prefill is supported
            pass
        else:
            prefill_tokens = state.last_response[-agent_config.K :]
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
            # this assumes that the last message is a user message
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})

        return accumulated_output, False, messages

    def compute_price(self, response_usage: Any) -> float:
        """
        Compute the price for token usage for OpenAI-compatible models.

        Args:
            response_usage: OpenAI response usage object

        Returns:
            float: The computed price in dollars
        """
        total_input_tokens = response_usage.prompt_tokens
        total_output_tokens = response_usage.completion_tokens

        # Apply adjustments for caching and reasoning
        if hasattr(response_usage, "reasoning_tokens"):
            total_output_tokens += response_usage.reasoning_tokens
        if hasattr(response_usage, "cached_tokens"):
            total_input_tokens -= response_usage.cached_tokens * 0.5

        return (total_input_tokens * self.input_price + total_output_tokens * self.output_price) / 1e6

    def compute_statistics(self, response_usage: Any) -> ResponseUsageBase:
        """
        Compute statistics from OpenAI response usage object.

        Args:
            response_usage: OpenAI response usage object containing prompt_tokens and completion_tokens

        Returns:
            OpenAIResponseUsage containing token usage statistics and cost
        """
        total_input_tokens = response_usage.prompt_tokens
        total_output_tokens = response_usage.completion_tokens
        cached_tokens = 0
        reasoning_tokens = 0
        percentage_cached = 0

        # Handle caching if supported
        if self.capabilities.supports_auto_prompt_caching and hasattr(response_usage, "cached_tokens"):
            cached_tokens = response_usage.cached_tokens
            percentage_cached = (cached_tokens / total_input_tokens * 100) if total_input_tokens > 0 else 0

        # Handle reasoning if supported
        if self.capabilities.supports_reasoning and hasattr(response_usage, "reasoning_tokens"):
            reasoning_tokens = response_usage.reasoning_tokens

        cost = self.compute_price(response_usage)

        return OpenAIResponseUsage(
            total_input_tokens=total_input_tokens,
            total_output_tokens=total_output_tokens,
            prompt_tokens=total_input_tokens,
            completion_tokens=total_output_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            percentage_cached=percentage_cached,
            cost=cost,
        )

    def extract_round_stats(self, state: "AgentState") -> ResponseUsageBase:
        """
        Extract round statistics from agent state for OpenAI models.

        Args:
            state: The current agent state

        Returns:
            OpenAIResponseUsage containing token usage statistics and cost
        """
        # Print basic statistics
        logger.info(f"Total input tokens  : {state.total_input_tokens}")
        logger.info(f"Total output tokens : {state.total_output_tokens}")

        # Create a response usage object that mimics OpenAI's format
        response_usage = type(
            "ResponseUsage",
            (),
            {
                "prompt_tokens": state.total_input_tokens,
                "completion_tokens": state.total_output_tokens,
                "cached_tokens": state.total_cached_tokens,
                "reasoning_tokens": state.total_reasoning_tokens,
            },
        )

        stats = self.compute_statistics(response_usage)

        if self.capabilities.supports_auto_prompt_caching:
            logger.info(f"Total cached tokens: {stats['cached_tokens']}")
            logger.info(f"Percentage cached: {stats['percentage_cached']}%")
        if self.capabilities.supports_reasoning:
            logger.info(f"Total reasoning tokens: {stats['reasoning_tokens']}")

        logger.info(f"Total response time : {state.total_response_time} seconds")
        logger.warning(f"Total cost          : ${stats['cost']:.2f}")

        return OpenAIResponseUsage(
            total_input_tokens=stats["total_input_tokens"],
            total_output_tokens=stats["total_output_tokens"],
            prompt_tokens=stats["prompt_tokens"],
            completion_tokens=stats["completion_tokens"],
            cached_tokens=stats["cached_tokens"],
            reasoning_tokens=stats["reasoning_tokens"],
            percentage_cached=stats["percentage_cached"],
            cost=stats["cost"],
        )

    def update_message_content(self, messages: List[Dict], best_connector: str, new_response: str, accumulated_output: str) -> None:
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


class OpenAICompatibleModelConfig(OpenAIModelConfig):
    pass
