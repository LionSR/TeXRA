"""Anthropic-specific model handlers."""

import os
import re
from anthropic import Anthropic
from typing import Any

from ..logger import logger
from ..utils.file import read_file, write_file
from ..utils.xml import filter_tags_from_text, extract_text_from_tags
from ..utils.replacement import apply_replacement_regex, get_replacements_by_category
from ..utils.confirmation import CONFIRMATION_PROMPT_PATTERNS, wrap_confirmation_prompts

from ..agent.agent_state import AgentStateRound
from ..agent import AgentSettings, AgentConfig

from .model_handler import ModelHandler
from .model_config import ModelConfig
from .response_usage import AnthropicResponseUsage

from .tool_handler import ToolState


class AnthropicHandler(ModelHandler):
    """Anthropic-specific handlers."""

    def __init__(self, config: ModelConfig):
        super().__init__(config)

    def get_client(self) -> Anthropic:
        """Get Anthropic client."""
        api_key = self.get_api_key()
        logger.info("Using Anthropic API key.")
        return Anthropic(api_key=api_key)

    def create_response(
        self,
        client: Anthropic,
        messages: list[dict],
        temperature: float,
        system_prompt: str | None = None,
        end_tag: str | None = None,
    ) -> Any:
        """Create a response using Anthropic's API."""
        return client.beta.messages.create(
            model=self.config.full_name,
            max_tokens=self.config.max_output_tokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[end_tag] if end_tag else None,
            system=system_prompt,
        )

    def initialize_messages(
        self,
        user_prefix: str,
        user_request: str,
        figure_files: list[str] | None = None,
        system_prompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for Anthropic models."""
        # Create content list with user prefix
        content = [{"type": "text", "text": user_prefix}]

        # Add images if provided
        if figure_files:
            content.extend(self.create_image_message(figure_files))

        # Add user request with optional caching
        request = {
            "type": "text",
            "text": user_request,
            **({"cache_control": {"type": "ephemeral"}} if self.capabilities.supports_prompt_caching else {}),
        }
        content.append(request)

        # Note: Anthropic handles system prompts differently via create_response()
        return [{"role": "user", "content": content}]

    def create_reflection_message(
        self,
        messages: list[dict],
        user_message: str,
        figure_files: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message for Anthropic models."""
        # Create content list
        content = []

        # Add images if provided
        if figure_files:
            content.extend(self.create_image_message(figure_files))

        # Add message with optional caching
        message = {
            "type": "text",
            "text": user_message,
            **({"cache_control": {"type": "ephemeral"}} if self.capabilities.supports_prompt_caching else {}),
        }
        content.append(message)

        # Manage cache control for previous messages
        if self.capabilities.supports_prompt_caching and isinstance(messages[-1]["content"], list):
            prev_content = messages[-1]["content"]
            if len(prev_content) >= 2:
                prev_content[-2].pop("cache_control", None)
            elif len(prev_content) == 1:
                # sus, why 0? maybe to pop up the cache control in user message
                messages[0]["content"][-1].pop("cache_control", None)

        messages.append({"role": "user", "content": content})
        return messages

    def create_image_content(self, image_contents: list) -> list[dict]:
        """Create image content for Anthropic models."""

        def create_content_pair(image: dict) -> list[dict]:
            is_pdf = self.capabilities.supports_native_pdf and image["media_type"] == "application/pdf"
            return [
                {"type": "text", "text": f"{'Document' if is_pdf else 'Image'}: {image['file_name']}"},
                {"type": "document" if is_pdf else "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}},
            ]

        return [item for image in image_contents for item in create_content_pair(image)]

    def extract_response(
        self,
        response_object: Any,
        end_tag: str,
        auto_confirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from Anthropic response."""
        if hasattr(response_object, "error"):
            error_msg = f"API error: {response_object.error}"
            logger.error(error_msg)
            raise ValueError(error_msg)

        # Check for empty response
        if response_object.usage.output_tokens == 3:  # Anthropic specific empty response check
            error_msg = "No output generated - API returned empty response"
            logger.error(error_msg)
            logger.debug(f"response_object: {response_object}")
            logger.debug(f"response_object.content: {response_object.content}")
            raise ValueError(error_msg)

        # Extract base response
        stop_reason = response_object.stop_reason
        new_response = response_object.content[0].text.strip()

        # Handle auto confirmation
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
        new_response = apply_replacement_regex(new_response, get_replacements_by_category("auto_confirmation"), flags=re.DOTALL | re.MULTILINE)

        if auto_confirmation:
            new_response = filter_tags_from_text(new_response, "monologue")

        # Add end tag if needed
        if stop_reason == "stop_sequence" and end_tag not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, response_object.usage, stop_reason

    def add_continue_message(
        self,
        messages: list[dict],
        state_round: AgentStateRound,
        tool_state: ToolState,
        agent_settings: AgentSettings,
        agent_config: AgentConfig,
    ) -> None:
        """Handle continuation for Anthropic models."""
        # Skip if model doesn't need confirmation
        if not self.capabilities.likes_to_ask_for_confirmation or not agent_config.tool_config.auto_confirmation:
            return

        # Create continuation message based on round count
        output_tokens = state_round.model_usage.get("output_tokens", 0) if state_round.model_usage else 0

        if state_round.continuation_count <= 1:
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

        # Handle document tag if present
        document_tag_start = f"<{agent_settings.document_tag}>"
        first_lines = tool_state.last_response.split("\n")[:10]
        for line in first_lines:
            if line.strip().startswith(document_tag_start):
                logger.warning(f"Removing document tag prefix {document_tag_start} from response")
                tool_state.last_response = tool_state.last_response.replace(line, "", 1).strip()
                break

        # Filter monologue tags
        tool_state.last_response = filter_tags_from_text(tool_state.last_response, "monologue")

        # Update messages
        logger.info("Adding User message")
        logger.debug(user_message_continuation)

        # better to merge with extract_response?
        # Solution 1: keep updating the last assistant message
        if messages[-1]["role"] == "user":
            if messages[-2]["role"] == "assistant":
                logger.warning("Appending new response to the previous assistant message")
                if isinstance(messages[-2]["content"], list):
                    messages[-2]["content"].append({"type": "text", "text": "\n" + tool_state.last_response.strip()})
                elif isinstance(messages[-2]["content"], str):
                    messages[-2]["content"] += "\n" + tool_state.last_response.strip()
            messages[-1]["content"] = user_message_continuation.strip()
        elif messages[-1]["role"] == "assistant":
            messages.append({"role": "user", "content": user_message_continuation.strip()})

    def initialize_output_and_prefill(
        self,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: list[dict],
        tool_state: ToolState,
        output_file: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill for Anthropic models."""
        if not os.path.exists(output_file) or os.path.getsize(output_file) <= 15:
            if agent_config.tool_config.use_prefill_from_input and tool_state.first_k_chars_from_input:
                prefill += tool_state.first_k_chars_from_input
                tool_state.update_accumulated_output(tool_state.first_k_chars_from_input)

            logger.debug(f"Anthropic prefill: {prefill}")

            if tool_state.accumulated_output == "<scratchpad>" and prefill == "<scratchpad>":
                write_file(output_file, prefill)
            elif agent_settings.output_ext == "xml":
                write_file(output_file, prefill + "\n")

            messages.append({"role": "assistant", "content": prefill})
            return False, messages

        # Get prefill from existing and non-trivial file
        file_content = read_file(output_file)

        if self.capabilities.likes_to_ask_for_confirmation and agent_config.tool_config.auto_confirmation:
            file_content = filter_tags_from_text(file_content, "monologue")
            file_content = apply_replacement_regex(file_content, get_replacements_by_category("auto_confirmation"), flags=re.DOTALL | re.MULTILINE)
        file_content = file_content.strip()

        if agent_settings.has_end_tag(file_content):
            logger.debug("End tag detected - skipping continuation")
            if isinstance(messages[-1]["content"], list):
                messages[-1]["content"][-1]["text"] = file_content
            else:
                messages[-1]["content"] = file_content

            if messages[-1]["content"][-1].get("cache_control"):
                messages[-1]["content"][-1].pop("cache_control")
            return True, messages

        logger.warning("Output file exists but no end tag found - continuing from file")
        tool_state.update_accumulated_output(file_content)
        if self.capabilities.supports_prompt_caching:
            content = [{"type": "text", "text": file_content, "cache_control": {"type": "ephemeral"}}]
        else:
            content = file_content
        logger.debug(f"Using existing content as prefill: {output_file}")

        messages.append({"role": "assistant", "content": content})
        return False, messages

    def compute_price(self, response_usage: Any) -> float:
        """Compute the price for token usage."""
        base_price = (response_usage.input_tokens * self.config.input_price + response_usage.output_tokens * self.config.output_price) / 1e6

        if self.capabilities.supports_prompt_caching:
            if hasattr(response_usage, "cache_creation_input_tokens"):
                base_price += (response_usage.cache_creation_input_tokens * self.config.input_price * 1.25) / 1e6
            if hasattr(response_usage, "cache_read_input_tokens"):
                base_price += (response_usage.cache_read_input_tokens * self.config.input_price * 0.1) / 1e6

        return base_price

    def compute_statistics(self, response_usage: Any, response_time: float) -> AnthropicResponseUsage:
        """Compute model-specific statistics from response usage object."""
        return AnthropicResponseUsage.from_response(response_usage, self.compute_price(response_usage), response_time)

    def update_message_content(
        self, messages: list[dict], best_connector: str, new_response: str, tool_state: ToolState, auto_confirmation: bool = False
    ) -> None:
        """Update message content for Anthropic models."""
        logger.debug("Updating message content for Anthropic models")
        if messages[-1]["role"] == "assistant":
            last_message = messages[-1]

            if isinstance(last_message["content"], list):
                new_message = {"type": "text", "text": best_connector + new_response}
                last_message["content"].append(new_message)
            else:
                last_message["content"] = tool_state.accumulated_output

            if self.capabilities.supports_prompt_caching:
                if isinstance(last_message["content"], list):
                    # Add cache control to new message
                    last_message["content"][-1]["cache_control"] = {"type": "ephemeral"}
                    # Remove cache control from previous message if it exists
                    if len(last_message["content"]) >= 2 and isinstance(last_message["content"][-2], dict):
                        last_message["content"][-2].pop("cache_control", None)
                else:
                    # Initialize content list with single message
                    last_message["content"] = [{"type": "text", "text": tool_state.accumulated_output, "cache_control": {"type": "ephemeral"}}]

        # not finished
        # elif messages[-1]["role"] == "user":
        #     if self.config.capabilities.likes_to_ask_for_confirmation and auto_confirmation:
        #         new_response = wrap_confirmation_prompts(new_response)
        #         messages[-1]["content"] = new_response
        #     if messages[-2]["role"] == "assistant":
        #         messages[-2]["content"] = best_connector + new_response

    def should_continue(self, stop_reason: str, new_response: str, agent_settings: AgentSettings) -> bool:
        """Determine if Anthropic model should continue generating."""
        logger.info("Determining if should continue for Anthropic model via Anthropic API")
        return stop_reason not in ("max_tokens", "stop_sequence") and not agent_settings.has_end_tag(new_response)
