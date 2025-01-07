"""OpenAI-specific model handlers."""

import os
from openai import OpenAI
from typing import Any

from ..logger import logger

from ..utils.file import readFile

from .agent_state import AgentStateRound
from .agent_dataclass import AgentSetting
from .agent_config import AgentConfig

from .model_handler import ModelHandler
from .response_usage import OpenAIAPIResponseUsage

from .tool_state import ToolState

K_SLICE = 200


class OpenAIHandler(ModelHandler):
    """OpenAI-specific handlers."""

    def getClient(self) -> OpenAI:
        """Get OpenAI client."""
        api_key = self.get_api_key()
        logger.info("Using OpenAI API key.")
        return OpenAI(api_key=api_key)

    def createResponse(
        self,
        client: OpenAI,
        messages: list[dict],
        temperature: float,
        systemPrompt: str | None = None,
        endTag: str | None = None,
    ) -> Any:
        """Create a response using OpenAI's API."""
        kwargs = {
            "model": self.config.fullName,
            "messages": messages,
            "max_completion_tokens" if "o1" in self.config.name.lower() else "max_tokens": self.config.maxOutputTokens,
            "temperature": 1.0 if "o1" in self.config.name.lower() else temperature,
        }

        if endTag and "o1" not in self.config.name.lower():
            kwargs["stop"] = [endTag]

        if self.config.name.lower() == "o1":
            kwargs["reasoning_effort"] = "high"

        return client.chat.completions.create(**kwargs)

    def initializeMessages(
        self,
        userPrefix: str,
        userRequest: str,
        figureFiles: list[str] | None = None,
        systemPrompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for OpenAI models."""
        messages = []

        # Handle system prompt differently for O1 models
        if self.config.name in ["o1-", "o1preview"]:
            messages = [{"role": "user", "content": [{"type": "text", "text": systemPrompt}, {"type": "text", "text": userPrefix}]}]
        else:
            if systemPrompt:
                # note that for openai native models, they have been renamed to "developer" but "system" still works
                messages.append({"role": "system", "content": systemPrompt})

            # Create content list with user prefix
            content = [{"type": "text", "text": userPrefix}]

            # Add images if provided
            if figureFiles:
                content.extend(self.create_image_message(figureFiles))

            # Add user request
            request = {"type": "text", "text": userRequest}
            content.append(request)

            messages.append({"role": "user", "content": content})

        return messages

    def create_reflection_messages(
        self,
        messages: list[dict],
        userMessage: str,
        figureFiles: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message for OpenAI models."""
        content = []

        if figureFiles:
            content.extend(self.create_image_message(figureFiles))
        content.append({"type": "text", "text": userMessage})
        messages.append({"role": "user", "content": content})
        return messages

    def createImageContent(self, imageContents: list) -> list[dict]:
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
                        "detail": "high",
                    },
                },
            ]

        return [item for image in imageContents for item in create_content_pair(image)]

    def extract_response(
        self,
        responseObject: Any,
        endTag: str,
        autoConfirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics from OpenAI response."""
        if not (hasattr(responseObject, "choices") and responseObject.choices):
            error_msg = "Invalid response from API: missing choices"
            logger.error(error_msg)
            logger.debug(responseObject)
            raise ValueError(error_msg)

        # Extract base response
        choice = responseObject.choices[0]
        stopReason = choice.finish_reason
        newResponse = choice.message.content.strip()

        # Add end tag if response was stopped and tag isn't present
        if all([stopReason == "stop", endTag]) and endTag not in newResponse:
            newResponse = f"{newResponse}\n{endTag}"

        return newResponse, responseObject.usage, stopReason

    def add_continue_message(
        self,
        messages: list[dict],
        stateRound: AgentStateRound,
        toolState: ToolState,
        agentSetting: AgentSetting,
        agentConfig: AgentConfig,
    ) -> None:
        """Handle continuation for OpenAI models."""
        # Skip if model supports assistant prefill
        if self.capabilities.supportsAssistantPrefill:
            logger.debug("Skipping continuation - assistant prefill is supported")
            return

        # Create continuation message with last K tokens
        prefill_tokens = toolState.lastResponse[-K_SLICE:]
        userMessageContinuation = (
            f"Your response got cut off, because you only have limited response space. "
            f"Continue writing exactly from where you left off until the very end, "
            f"marked by {agentSetting.endTag}. "
            "Avoid repeat yourself and avoid starting over. "
            f'Start your response at the next token after: "{prefill_tokens}"'
        )

        # Add continuation message
        logger.info("Adding continuation message to conversation")
        logger.debug(f"Continuation message: {userMessageContinuation}")
        messages.append({"role": "user", "content": [{"type": "text", "text": userMessageContinuation}]})

    def initialize_output_and_prefill(
        self,
        agentConfig: AgentConfig,
        agentSetting: AgentSetting,
        messages: list[dict],
        toolState: ToolState,
        outputFile: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill for OpenAI-compatible models."""
        if not os.path.exists(outputFile) or os.path.getsize(outputFile) <= 15:
            if agentConfig.toolConfig.usePrefillFromInput and toolState.firstKCharsFromInput:
                prefill += toolState.firstKCharsFromInput
                toolState.update_accumulatedOutput("")
                prefill = f"<{agentSetting.documentTag}>{toolState.firstKCharsFromInput}"

            messages[-1]["content"].append({"type": "text", "text": f"Start your response with\n{prefill}"})
            return False, messages

        fileContent = readFile(outputFile)
        messages.append({"role": "assistant", "content": fileContent})

        if agentSetting.has_endTag(fileContent):
            logger.debug("End tag detected - skipping continuation")
            if isinstance(messages[-1]["content"], list):
                messages[-1]["content"][-1]["text"] = fileContent
            else:
                messages[-1]["content"] = fileContent
            return True, messages

        logger.warning("Output file exists but no end tag found - continuing from file")
        toolState.update_accumulatedOutput(fileContent)
        state = AgentStateRound.initialize(0)
        toolState.lastResponse = toolState.accumulatedOutput
        self.add_continue_message(messages, state, toolState, agentSetting, agentConfig)

        # here state is somehow not possible to be passed outside?
        # also here continue message is added here, not like later it was handled separately. We should make them consistent...
        return False, messages

    def computePrice(self, responseUsage: Any) -> float:
        """Compute price for OpenAI token usage."""
        # Handle Google models that return None for usage
        if responseUsage is None:
            return 0.0

        # Get token counts with defaults for Google models
        prompt_tokens = getattr(responseUsage, "prompt_tokens", 0)
        completion_tokens = getattr(responseUsage, "completion_tokens", 0)

        basePrice = (prompt_tokens * self.config.inputPrice + completion_tokens * self.config.outputPrice) / 1e6

        # Handle special token types
        if hasattr(responseUsage, "reasoning_tokens"):
            basePrice += (responseUsage.reasoning_tokens * self.config.outputPrice) / 1e6
        if hasattr(responseUsage, "cached_tokens"):
            basePrice -= (responseUsage.cached_tokens * self.config.inputPrice * 0.5) / 1e6

        return basePrice

    def computeResponseUsage(self, responseUsage: Any, responseTime: float) -> OpenAIAPIResponseUsage:
        """Compute OpenAI-specific statistics."""
        # For Google models, create a minimal usage object with zeros
        if responseUsage is None:
            return OpenAIAPIResponseUsage.from_response(
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
                self.computePrice(responseUsage),
                responseTime,
            )

        return OpenAIAPIResponseUsage.from_response(responseUsage, self.computePrice(responseUsage), responseTime)

    def updateMessageContent(
        self, messages: list[dict], bestConnector: str, newResponse: str, toolState: ToolState, autoConfirmation: bool = False
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
                        messages[-2]["content"].append({"type": "text", "text": bestConnector + newResponse})
                    else:
                        logger.error("Second last message content is not a list")
                        messages[-2]["content"] = toolState.accumulatedOutput
                    # Remove continuation prompt
                    messages.pop()
            else:
                logger.debug("Last message is a request message rather than a ask to continue after cut off")
                # otherwise last message is a request message rather than a ask to continue after cut off
                messages.append({"role": "assistant", "content": [{"type": "text", "text": toolState.accumulatedOutput}]})

    def should_continue(self, stopReason: str, newResponse: str, agentSetting: AgentSetting) -> bool:
        """Determine if OpenAI model should continue generating."""
        logger.info("Determining if should continue for OpenAI model via OpenAI API")
        return stopReason == "length" and not agentSetting.has_endTag(newResponse)
