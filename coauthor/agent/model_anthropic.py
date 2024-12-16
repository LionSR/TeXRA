"""Anthropic-specific model configuration."""

import os
import re
from dataclasses import dataclass
from typing import Any
from anthropic import Anthropic

from ..utils.confirmation import CONFIRMATION_PROMPT_PATTERNS, wrap_confirmation_prompts

from ..agent import AgentSettings, AgentConfig
from ..agent.agent_state import AgentRoundState
from ..logger import logger
from ..utils.replacement import apply_replacement_regex, get_replacements_by_category

from ..utils.file import read_file, write_file
from ..utils.xml import extract_text_from_tags, filter_tags_from_text

from .model_base import ModelHandler, ModelProvider
from .response_usage import AnthropicResponseUsage
from .agent_state import ToolState


@dataclass
class AnthropicModelHandler(ModelHandler):
    """Configuration for Anthropic models."""

    provider: ModelProvider = ModelProvider.ANTHROPIC

    def get_client(self):
        """Get Anthropic client."""
        return Anthropic(api_key=self.provider.get_api_key())

    def create_response(
        self,
        client: Anthropic,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = "",
        end_tag: str | None = "",
    ) -> Any:
        """Create a response using Anthropic's API."""
        extra_headers = []
        if self.capabilities.supports_prompt_caching:
            extra_headers.append("prompt-caching-2024-07-31")
        if self.capabilities.supports_native_pdf:
            extra_headers.append("pdfs-2024-09-25")

        return client.beta.messages.create(
            model=self.full_name,
            max_tokens=self.max_output_tokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[end_tag] if end_tag else None,
            system=system_prompt,
            betas=extra_headers if extra_headers else None,
        )

    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: str | None = None) -> list[dict]:
        """Initialize messages for the conversation."""
        content = [{"type": "text", "text": user_prefix}]

        if figure_files:
            image_content = self.create_image_message(figure_files)
            content.extend(image_content)

        # Add user request with optional caching
        request = {"type": "text", "text": user_request}
        if self.capabilities.supports_prompt_caching:
            request["cache_control"] = {"type": "ephemeral"}
        content.append(request)

        return [{"role": "user", "content": content}]

    def create_reflection_message(self, messages: list[dict], user_message: str, figure_files=None) -> list[dict]:
        """Create a reflection message for Anthropic models."""
        content = []

        if figure_files:
            image_content = self.create_image_message(figure_files)
            content.extend(image_content)

        # Add user message with optional caching
        message = {"type": "text", "text": user_message}
        if self.capabilities.supports_prompt_caching:
            message["cache_control"] = {"type": "ephemeral"}
            # Manage cache control count
            if isinstance(messages[-1]["content"], list):
                if len(messages[-1]["content"]) == 1:
                    messages[0]["content"][-1].pop("cache_control", None)
                elif len(messages[-1]["content"]) >= 2:
                    messages[-1]["content"][-2].pop("cache_control", None)
        content.append(message)

        messages.append({"role": "user", "content": content})
        return messages

    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for Anthropic models."""
        content = []
        for image in image_contents:
            if self.capabilities.supports_native_pdf and image["media_type"] == "application/pdf":
                content.extend(
                    [
                        {"type": "text", "text": f"Document: {image['file_name']}"},
                        {"type": "document", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}},
                    ]
                )
            else:
                content.extend(
                    [
                        {"type": "text", "text": f"Image: {image['file_name']}"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image["media_type"],
                                "data": image["data"],
                            },
                        },
                    ]
                )
        return content

    def extract_response(self, response_object, end_tag: str, auto_confirmation: bool = False) -> tuple[str, Any, str]:
        """
        Extract response text and usage statistics from Anthropic response object.
        Returns:
            Tuple containing:
            - response text (str)
            - response usage object (Any)
            - stop reason (str)
        """
        if hasattr(response_object, "error"):
            logger.error(f"API error: {response_object.error}")
            raise ValueError(f"API error: {response_object.error}")

        stop_reason = response_object.stop_reason

        if response_object.usage.output_tokens == 3:  # Anthropic specific empty response check
            logger.error("No output generated - API returned empty response")
            logger.debug(f"response_object: {response_object}")
            logger.debug(f"response_object.content: {response_object.content}")
            raise ValueError("No output generated")

        # Extract and process response text
        new_response = response_object.content[0].text.strip()
        if self.capabilities.likes_to_ask_for_confirmation and auto_confirmation:
            new_response = wrap_confirmation_prompts(new_response)

        # Check for confirmation patterns
        if any(pattern.lower() in new_response.lower() for pattern in CONFIRMATION_PROMPT_PATTERNS):
            stop_reason = "ask_for_confirmation"

        # Handle output tags if present
        if "<output>" in new_response and self.capabilities.likes_to_ask_for_confirmation and auto_confirmation:
            logger.warning("Output tag detected - extracting latex code from <output> tags")
            new_response = extract_text_from_tags(new_response, "output")
            logger.warning("No <output> tags found in response" if new_response == new_response else "Extracted content from <output> tags")

        # Apply formatting
        new_response = apply_replacement_regex(new_response, get_replacements_by_category("anthropic"))
        new_response = filter_tags_from_text(new_response, "monologue")

        # Add end tag if needed
        if stop_reason == "stop_sequence" and end_tag not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, response_object.usage, stop_reason

    def handle_continuation(
        self,
        messages: list[dict],
        round_state: AgentRoundState,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ) -> None:
        """
        Anthropic models before sonnet++/haiku+ don't need continuation handling.
        However, for sonnet++/haiku+ we need to handle the continuation because they have been hard-coded to ask for confirmation.
        """
        # add a flag for enabling this mode
        if self.capabilities.likes_to_ask_for_confirmation and agent_settings.auto_confirmation:
            output_tokens = round_state.model_usage.get("output_tokens", 0) if round_state.model_usage else 0
            if round_state.continuation_count <= 1:
                user_message_continuation = (
                    "Proceed. "
                    "If no previous revised output of the document is provided, "
                    "please start from the very beginning of the document and work through the full document systematically. "
                    "Note that you have an effectively infinite token response limit "
                    "because the system that you are part of handles continuations automatically. Therefore, just output the complete document. "
                    f"The total number of tokens you output in the last turn is {output_tokens}, "
                    "but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn. "
                    "Respond the latex code of the next section in the <output> ... </output> tags."
                )
            else:
                user_message_continuation = (
                    "Proceed to write fully the next part/section (not just a subsection, which is not enough). "
                    "Continue writing exactly from where you left off until the whole document has been systematically revised. "
                    "Aim for double the length of output as previous turns. "
                    "Remember to stay professional and write latex code all the time. "
                    "Note that you have an effectively infinite token response limit "
                    "because the system that you are part of handles continuations automatically. Therefore, just output the complete document. "
                    f"The total number of tokens you output in the last turn is {output_tokens}, "
                    "but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn. "
                    "Respond the latex code of the next section in the <output> ... </output> tags."
                )
                # this should also consider what if continue from existing output of a document
                document_tag_start_string = f"<{agent_settings.document_tag}>"
                first_lines = tool_state.last_response.split("\n")[:10]
                for line in first_lines:
                    if line.strip().startswith(document_tag_start_string):
                        logger.warning(f"Removing document tag prefix {document_tag_start_string} from response")
                        tool_state.last_response = tool_state.last_response.replace(line, "", 1).strip()
                        break

            logger.info("Adding User message")
            logger.debug(user_message_continuation)

            tool_state.last_response = filter_tags_from_text(tool_state.last_response, "monologue")

            # solution 1: keep updating the last assistant message
            if messages[-1]["role"] == "user":
                if messages[-2]["role"] == "assistant":
                    logger.warning("Appending new response to the previous assistant message")
                    if isinstance(messages[-2]["content"], list):
                        messages[-2]["content"].append({"type": "text", "text": "\n" + tool_state.last_response})
                    elif isinstance(messages[-2]["content"], str):
                        messages[-2]["content"] += "\n" + tool_state.last_response
                messages[-1]["content"] = user_message_continuation
            elif messages[-1]["role"] == "assistant":
                messages.append({"role": "user", "content": user_message_continuation})
        else:
            pass

    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: list[dict],
        prefill: str,
        tool_state: ToolState,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill for Anthropic models."""
        if os.path.exists(output_file) and os.path.getsize(output_file) > 15:
            # try to get prefill from existing file
            file_content = read_file(output_file)
            file_content = filter_tags_from_text(file_content, "monologue").strip()
            file_content = apply_replacement_regex(file_content, get_replacements_by_category("lazy"), flags=re.DOTALL | re.MULTILINE)

            if agent_settings.has_end_tag(file_content):
                logger.debug("End tag detected - skipping continuation")
                if messages[-1]["content"][-1].get("cache_control"):
                    messages[-1]["content"][-1].pop("cache_control")
                content = file_content
                return True, messages
            else:
                logger.warning("Output file exists but no end tag found - continuing from file")
                tool_state.update_accumulated_output(file_content)
                if self.capabilities.supports_prompt_caching:
                    content = [{"type": "text", "text": file_content, "cache_control": {"type": "ephemeral"}}]
                else:
                    content = file_content
                logger.debug(f"Using existing content as prefill: {output_file}")
        else:
            if agent_config.use_prefill_from_input and agent_settings.output_ext == "tex" and tool_state.first_k_tex_document:
                prefill += tool_state.first_k_tex_document
                tool_state.update_accumulated_output(tool_state.first_k_tex_document)

            content = prefill
            logger.debug(f"Anthropic prefill: {prefill}")

            if tool_state.accumulated_output == "<scratchpad>" and prefill == "<scratchpad>":
                write_file(output_file, prefill)
            elif agent_settings.output_ext == "xml":
                write_file(output_file, prefill + "\n")

        messages.append({"role": "assistant", "content": content})
        return False, messages

    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        base_price = (response_usage.input_tokens * self.input_price + response_usage.output_tokens * self.output_price) / 1e6

        # Add caching costs if supported
        if self.capabilities.supports_prompt_caching:
            if hasattr(response_usage, "cache_creation_tokens"):
                base_price += (response_usage.cache_creation_tokens * self.input_price * 1.25) / 1e6
            if hasattr(response_usage, "cache_read_tokens"):
                base_price += (response_usage.cache_read_tokens * self.input_price * 0.1) / 1e6

        return base_price

    def compute_statistics(self, response_usage: Any, response_time: float) -> AnthropicResponseUsage:
        """Compute model-specific statistics from response usage object."""
        return AnthropicResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState) -> None:
        """Update message content for Anthropic models."""
        logger.debug("Updating message content for Anthropic models")
        if messages[-1]["role"] == "assistant":
            last_message = messages[-1]

            if self.capabilities.supports_prompt_caching:
                if isinstance(last_message["content"], list):
                    # Remove cache_control from previous message if it exists
                    if len(last_message["content"]) >= 2 and isinstance(last_message["content"][-2], dict):
                        last_message["content"][-2].pop("cache_control", None)

                    # Append new message with cache control
                    last_message["content"].append({"type": "text", "text": best_connector + new_response, "cache_control": {"type": "ephemeral"}})
                else:
                    # Initialize content list with single message
                    last_message["content"] = [{"type": "text", "text": tool_state.accumulated_output, "cache_control": {"type": "ephemeral"}}]
            else:
                if isinstance(last_message["content"], list):
                    last_message["content"].append({"type": "text", "text": best_connector + new_response})
                else:
                    last_message["content"] = tool_state.accumulated_output
