"""Anthropic-specific model handlers."""

import os
import re
from anthropic import Anthropic
from typing import Any

from ..logger import logger

from ..utils.file import readFile, writeFile
from ..utils.xml import filterTagsFromText, extractTextFromTag
from ..utils.replacement import applyReplacementRegex, getReplacementsByCategory
from ..utils.confirmation import CONFIRMATION_PROMPT_PATTERNS, wrapConfirmationPrompts

from ..agent.agent_state import AgentStateRound
from ..agent import AgentSetting, AgentConfig

from .model_handler import ModelHandler
from .model_config import ModelConfig

from .response_usage import AnthropicAPIResponseUsage
from .tool_state import ToolState


class AnthropicHandler(ModelHandler):
    """Anthropic-specific handlers."""

    def __init__(self, config: ModelConfig):
        super().__init__(config)

    def getClient(self) -> Anthropic:
        """Get Anthropic client."""
        api_key = self.get_api_key()
        logger.info("Using Anthropic API.")
        return Anthropic(api_key=api_key)

    def createResponse(
        self,
        client: Anthropic,
        messages: list[dict],
        temperature: float,
        systemPrompt: str | None = None,
        endTag: str | None = None,
    ) -> Any:
        """Create a response using Anthropic's API."""
        return client.beta.messages.create(
            model=self.config.fullName,
            max_tokens=self.config.maxOutputTokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[endTag] if endTag else None,
            system=systemPrompt,
        )
        # rememeber to use snake_case for the keys since these are from the apis

    def initializeMessages(
        self,
        userPrefix: str,
        userRequest: str,
        figureFiles: list[str] | None = None,
        systemPrompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for Anthropic models."""
        # Create content list with user prefix
        content = [{"type": "text", "text": userPrefix}]

        # Add images if provided
        if figureFiles:
            content.extend(self.create_image_message(figureFiles))

        # Add user request with optional caching
        request = {
            "type": "text",
            "text": userRequest,
            **({"cache_control": {"type": "ephemeral"}} if self.capabilities.supportsPromptCaching else {}),
        }
        content.append(request)

        # Note: Anthropic handles system prompts differently via createResponse()
        return [{"role": "user", "content": content}]

    def create_reflection_messages(
        self,
        messages: list[dict],
        userMessage: str,
        figureFiles: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message for Anthropic models."""
        # Create content list
        content = []

        # Add images if provided
        if figureFiles:
            content.extend(self.create_image_message(figureFiles))

        # Add message with optional caching
        message = {
            "type": "text",
            "text": userMessage,
            **({"cache_control": {"type": "ephemeral"}} if self.capabilities.supportsPromptCaching else {}),
        }
        content.append(message)

        # Manage cache control for previous messages
        if self.capabilities.supportsPromptCaching and isinstance(messages[-1]["content"], list):
            prev_content = messages[-1]["content"]
            if len(prev_content) >= 2:
                prev_content[-2].pop("cache_control", None)
            elif len(prev_content) == 1:
                # sus, why 0? maybe to pop up the cache control in user message
                messages[0]["content"][-1].pop("cache_control", None)

        messages.append({"role": "user", "content": content})
        return messages

    def createImageContent(self, imageContents: list) -> list[dict]:
        """Create image content for Anthropic models."""

        def create_content_pair(image: dict) -> list[dict]:
            is_pdf = self.capabilities.supportsNativePdf and image["media_type"] == "application/pdf"
            return [
                {"type": "text", "text": f"{'Document' if is_pdf else 'Image'}: {image['file_name']}"},
                {"type": "document" if is_pdf else "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}},
            ]

        return [item for image in imageContents for item in create_content_pair(image)]

    def extractResponse(
        self,
        responseObject: Any,
        endTag: str,
        autoConfirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from Anthropic response."""
        if hasattr(responseObject, "error"):
            error_msg = f"API error: {responseObject.error}"
            logger.error(error_msg)
            raise ValueError(error_msg)

        # Check for empty response
        if responseObject.usage.output_tokens == 3:  # Anthropic specific empty response check
            error_msg = "No output generated - API returned empty response"
            logger.error(error_msg)
            logger.debug(f"responseObject: {responseObject}")
            logger.debug(f"responseObject.content: {responseObject.content}")
            raise ValueError(error_msg)

        # Extract base response
        stopReason = responseObject.stop_reason
        newResponse = responseObject.content[0].text.strip()

        # Handle auto confirmation
        if self.capabilities.likesToAskForConfirmation and autoConfirmation:
            newResponse = wrapConfirmationPrompts(newResponse)

        # Check for confirmation patterns
        if any(pattern.lower() in newResponse.lower() for pattern in CONFIRMATION_PROMPT_PATTERNS):
            stopReason = "ask_for_confirmation"

        # Handle output tags if present
        if "<output>" in newResponse and self.capabilities.likesToAskForConfirmation and autoConfirmation:
            logger.warning("Output tag detected - extracting latex code from <output> tags")
            newResponse = extractTextFromTag(newResponse, "output")
            logger.warning("No <output> tags found in response" if newResponse == newResponse else "Extracted content from <output> tags")

        # Apply formatting
        newResponse = applyReplacementRegex(newResponse, getReplacementsByCategory("autoConfirmation"), flags=re.DOTALL | re.MULTILINE)

        if autoConfirmation:
            newResponse = filterTagsFromText(newResponse, "monologue")

        # Add end tag if needed
        if stopReason == "stop_sequence" and endTag not in newResponse:
            newResponse += f"\n{endTag}"

        return newResponse, responseObject.usage, stopReason

    def add_continue_message(
        self,
        messages: list[dict],
        stateRound: AgentStateRound,
        toolState: ToolState,
        agentSetting: AgentSetting,
        agentConfig: AgentConfig,
    ) -> None:
        """Handle continuation for Anthropic models."""
        # Skip if model doesn't need confirmation
        if not self.capabilities.likesToAskForConfirmation or not agentConfig.toolConfig.autoConfirmation:
            return

        # Create continuation message based on round count
        output_tokens = stateRound.APIUsage.get("output_tokens", 0) if stateRound.APIUsage else 0

        if stateRound.continuationCount <= 1:
            userMessageContinuation = (
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
            userMessageContinuation = (
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
        documentTagStart = f"<{agentSetting.documentTag}>"
        firstLines = toolState.lastResponse.split("\n")[:10]
        for line in firstLines:
            if line.strip().startswith(documentTagStart):
                logger.warning(f"Removing document tag prefix {documentTagStart} from response")
                toolState.lastResponse = toolState.lastResponse.replace(line, "", 1).strip()
                break

        # Filter monologue tags
        toolState.lastResponse = filterTagsFromText(toolState.lastResponse, "monologue")

        # Update messages
        logger.info("Adding User message")
        logger.debug(userMessageContinuation)

        # better to merge with extractResponse?
        # Solution 1: keep updating the last assistant message
        if messages[-1]["role"] == "user":
            if messages[-2]["role"] == "assistant":
                logger.warning("Appending new response to the previous assistant message")
                if isinstance(messages[-2]["content"], list):
                    messages[-2]["content"].append({"type": "text", "text": "\n" + toolState.lastResponse.strip()})
                elif isinstance(messages[-2]["content"], str):
                    messages[-2]["content"] += "\n" + toolState.lastResponse.strip()
            messages[-1]["content"] = userMessageContinuation.strip()
        elif messages[-1]["role"] == "assistant":
            messages.append({"role": "user", "content": userMessageContinuation.strip()})

    def initialize_output_and_prefill(
        self,
        agentConfig: AgentConfig,
        agentSetting: AgentSetting,
        messages: list[dict],
        toolState: ToolState,
        outputFile: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill for Anthropic models."""
        if not os.path.exists(outputFile) or os.path.getsize(outputFile) <= 15:
            if agentConfig.toolConfig.usePrefillFromInput and toolState.firstKCharsFromInput:
                prefill += toolState.firstKCharsFromInput
                toolState.update_accumulatedOutput(toolState.firstKCharsFromInput)

            logger.debug(f"Anthropic prefill: {prefill}")

            if toolState.accumulatedOutput == "<scratchpad>" and prefill == "<scratchpad>":
                writeFile(outputFile, prefill)
            elif agentSetting.outputExt == "xml":
                writeFile(outputFile, prefill + "\n")

            messages.append({"role": "assistant", "content": prefill})
            return False, messages

        # Get prefill from existing and non-trivial file
        fileContent = readFile(outputFile)

        if self.capabilities.likesToAskForConfirmation and agentConfig.toolConfig.autoConfirmation:
            fileContent = filterTagsFromText(fileContent, "monologue")
            fileContent = applyReplacementRegex(fileContent, getReplacementsByCategory("autoConfirmation"), flags=re.DOTALL | re.MULTILINE)
        fileContent = fileContent.strip()

        if agentSetting.has_endTag(fileContent):
            logger.debug("End tag detected - skipping continuation")
            if isinstance(messages[-1]["content"], list):
                messages[-1]["content"][-1]["text"] = fileContent
            else:
                messages[-1]["content"] = fileContent

            if messages[-1]["content"][-1].get("cache_control"):
                messages[-1]["content"][-1].pop("cache_control")
            return True, messages

        logger.warning("Output file exists but no end tag found - continuing from file")
        toolState.update_accumulatedOutput(fileContent)
        if self.capabilities.supportsPromptCaching:
            content = [{"type": "text", "text": fileContent, "cache_control": {"type": "ephemeral"}}]
        else:
            content = fileContent
        logger.debug(f"Using existing content as prefill: {outputFile}")

        messages.append({"role": "assistant", "content": content})
        return False, messages

    def computePrice(self, responseUsage: Any) -> float:
        """Compute the price for token usage."""
        basePrice = (responseUsage.input_tokens * self.config.inputPrice + responseUsage.output_tokens * self.config.outputPrice) / 1e6

        if self.capabilities.supportsPromptCaching:
            if hasattr(responseUsage, "cache_creation_input_tokens"):
                basePrice += (responseUsage.cache_creation_input_tokens * self.config.inputPrice * 1.25) / 1e6
            if hasattr(responseUsage, "cache_read_input_tokens"):
                basePrice += (responseUsage.cache_read_input_tokens * self.config.inputPrice * 0.1) / 1e6

        return basePrice

    def computeResponseUsage(self, responseUsage: Any, responseTime: float) -> AnthropicAPIResponseUsage:
        """Compute model-specific response usage from response usage object."""
        return AnthropicAPIResponseUsage.from_response(responseUsage, self.computePrice(responseUsage), responseTime)

    def updateMessageContent(
        self, messages: list[dict], bestConnector: str, newResponse: str, toolState: ToolState, autoConfirmation: bool = False
    ) -> None:
        """Update message content for Anthropic models."""
        logger.debug("Updating message content for Anthropic models")
        if messages[-1]["role"] == "assistant":
            last_message = messages[-1]

            if isinstance(last_message["content"], list):
                new_message = {"type": "text", "text": bestConnector + newResponse}
                last_message["content"].append(new_message)
            else:
                last_message["content"] = toolState.accumulatedOutput

            if self.capabilities.supportsPromptCaching:
                if isinstance(last_message["content"], list):
                    # Add cache_control(snake_case) to new message
                    last_message["content"][-1]["cache_control"] = {"type": "ephemeral"}
                    # Remove cache control from previous message if it exists
                    if len(last_message["content"]) >= 2 and isinstance(last_message["content"][-2], dict):
                        last_message["content"][-2].pop("cache_control", None)
                else:
                    # Initialize content list with single message
                    last_message["content"] = [{"type": "text", "text": toolState.accumulatedOutput, "cache_control": {"type": "ephemeral"}}]

    def shouldContinue(self, stopReason: str, newResponse: str, agentSetting: AgentSetting) -> bool:
        """Determine if Anthropic model should continue generating."""
        logger.info("Determining if should continue for Anthropic model via Anthropic API")
        return stopReason not in ("max_tokens", "stop_sequence") and not agentSetting.has_endTag(newResponse)
