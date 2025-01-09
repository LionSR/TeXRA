"""Model-specific handlers."""

import os
from abc import ABC, abstractmethod
from typing import Any

from ..logger import logger

from ..utils.img import getBase64EncodedImage, countPdfPages, processPdfInput

from .agent_dataclass import AgentSetting
from .agent_config import AgentConfig
from .agent_state import AgentStateRound, AgentStateGlobal

from .model_config import ModelConfig, ModelProvider
from .tool_state import ToolState


# Default continuation limits
DEFAULT_CONTINUE_LIMIT = 10
CONFIRMATION_CONTINUE_LIMIT = 20

# Default token limits
DEFAULT_INPUT_TOKEN_LIMIT = 1500000
DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5


class ModelHandler(ABC):
    """Base class for model-specific handlers."""

    def __init__(self, config: ModelConfig):
        self.config = config
        self.capabilities = config.capabilities
        self.continueLimit = CONFIRMATION_CONTINUE_LIMIT if self.capabilities.likesToAskForConfirmation else DEFAULT_CONTINUE_LIMIT
        self.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT
        self.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR

    def get_api_key(self) -> str:
        """Get API key based on provider and OpenRouter configuration."""
        if self.config.useOpenRouter:
            if key := os.getenv("OPENROUTER_API_KEY"):
                return key
            raise ValueError("Missing OPENROUTER_API_KEY in environment")

        env_key = f"{self.config.provider.value.upper()}_API_KEY"
        if key := os.getenv(env_key):
            return key
        raise ValueError(f"Missing {env_key} in environment")

    def get_base_url(self) -> str | None:
        """Get base URL based on provider and OpenRouter configuration."""
        if self.config.useOpenRouter:
            return "https://openrouter.ai/api/v1"

        # Provider-specific base URLs
        BASE_URLS = {
            ModelProvider.GOOGLE: "https://generativelanguage.googleapis.com/v1beta/openai/",
            ModelProvider.OPENAI: None,  # OpenAI uses default base URL
            ModelProvider.ANTHROPIC: None,  # Anthropic uses default base URL
        }
        return BASE_URLS.get(self.config.provider)

    @property
    def is_openai_compatible(self) -> bool:
        """Check if this is using an OpenAI-compatible API."""
        return self.config.provider in [ModelProvider.OPENAI, ModelProvider.GOOGLE, ModelProvider.OTHERS]

    @property
    def is_anthropic(self) -> bool:
        """Check if this is an Anthropic model."""
        return self.config.provider == ModelProvider.ANTHROPIC

    @property
    def is_openai(self) -> bool:
        """Check if this is an OpenAI model."""
        return self.config.provider == ModelProvider.OPENAI

    @property
    def is_google(self) -> bool:
        """Check if this is a Google model."""
        return self.config.provider == ModelProvider.GOOGLE

    def processImage(self, figureFile: str, fileExtension: str) -> tuple[str, str]:
        """Process image for models.

        Args:
            figureFile: Path to the image file
            fileExtension: File extension (e.g. '.jpg', '.pdf')

        Returns:
            Tuple of (base64 encoded image data, media type)
        """
        img_data = getBase64EncodedImage(figureFile)
        ext = fileExtension.lower()

        media_types = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".pdf": "application/pdf" if (self.capabilities.supportsNativePdf and countPdfPages(figureFile) > 1) else "image/png",
        }

        if ext not in media_types:
            raise ValueError(f"Unsupported file extension: {fileExtension}")

        media_type = media_types[ext]
        if ext == ".pdf" and media_type == "image/png":
            img_data = processPdfInput(figureFile)

        return img_data, media_type

    def create_image_message(self, figureFiles: list[str]) -> list[dict]:
        """Create image messages for the conversation.

        This is a shared implementation that can be used by all providers.
        Individual providers can override if needed.
        """
        imageContents = []
        added_figures = []

        for figureFile in figureFiles:
            if not os.path.exists(figureFile) or os.path.getsize(figureFile) == 0:
                logger.error(f"File not found or empty: {figureFile}")
                continue

            fileExtension = os.path.splitext(figureFile)[1].lower()

            try:
                img_data, media_type = self.processImage(figureFile, fileExtension)
                logger.debug(f"Processed image: {figureFile}, type: {media_type}")

                if isinstance(img_data, list):
                    logger.debug(f"Adding {len(img_data)} pages to the image contents")
                    for i, data in enumerate(img_data):
                        imageContents.append({"file_name": f"{os.path.basename(figureFile)}_page_{i+1}", "data": data, "media_type": media_type})
                    added_figures.extend([f"{figureFile}_page_{i+1}" for i in range(len(img_data))])
                else:
                    logger.debug(f"Adding single page to the image contents: {figureFile}")
                    imageContents.append({"file_name": os.path.basename(figureFile), "data": img_data, "media_type": media_type})
                    added_figures.append(figureFile)
            except Exception as e:
                logger.error(f"Failed to process image {figureFile}: {e}")
                continue

        logger.info(f"Using images: {figureFiles}")
        logger.info(f"Successfully added: {added_figures}")

        return self.createImageContent(imageContents)

    def check_stop_conditions(
        self,
        stopReason: str,
        newResponse: str,
        stateRound: AgentStateRound,
        stateGlobal: AgentStateGlobal,
        agentSetting: AgentSetting,
    ) -> tuple[bool, bool]:
        """Check if the conversation should stop and print debug info if stopping.

        Args:
            stopReason: The reason for stopping from the model response
            newResponse: The new response text
            stateRound: The current round state
            stateGlobal: The global conversation state
            agentSetting: The agent settings

        Returns:
            Tuple of (endTurn: bool, should_stop: bool)
        """
        maxOutputTokens = self.maxOutputTokensFactor * stateGlobal.firstInputTokens if stateGlobal.firstInputTokens > 0 else float("inf")

        endTurn = stopReason in ["end_turn", "stop_sequence", "stop"]  # end_turn/stop_sequence is correct as this is what api returns
        encounterDocumentTag = f"</{agentSetting.documentTag}>" in newResponse
        continuation_limit = stateRound.continuationCount > self.continueLimit
        inputTokenLimit = stateGlobal.totalInputTokens > self.inputTokenLimit
        maxOutputTokensExceeded = stateGlobal.totalOutputTokens > maxOutputTokens

        if maxOutputTokensExceeded:
            logger.warning(f"Output tokens exceed {self.maxOutputTokensFactor}x input tokens")
            logger.warning(f"Total output tokens: {stateGlobal.totalOutputTokens}, " f"First input tokens: {stateGlobal.firstInputTokens}")

        should_stop = encounterDocumentTag or continuation_limit or inputTokenLimit

        # Print debug info if stopping
        if should_stop:
            logger.debug(
                f"StopFlags:\n"
                f"endTurn: {endTurn}\n"
                f"encounterDocumentTag: {encounterDocumentTag}\n"
                f"continuation_limit: {continuation_limit}\n"
                f"inputTokenLimit: {inputTokenLimit}\n"
                f"maxOutputTokens: {maxOutputTokens}\n"
            )

        return endTurn, should_stop

    @abstractmethod
    def getClient(self) -> Any:
        """Get the appropriate client for this model."""
        pass

    @abstractmethod
    def createResponse(
        self,
        client: Any,
        messages: list[dict],
        temperature: float,
        systemPrompt: str | None = None,
        endTag: str | None = None,
    ) -> Any:
        """Create a response using the model's API."""
        pass

    @abstractmethod
    def initializeMessages(
        self,
        userPrefix: str,
        userRequest: str,
        figureFiles: list[str] | None = None,
        systemPrompt: str | None = None,
    ) -> list[dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def createReflectionMessages(
        self,
        messages: list[dict],
        userMessage: str,
        figureFiles: list[str] | None = None,
    ) -> list[dict]:
        """Create a reflection message."""
        pass

    @abstractmethod
    def createImageContent(self, imageContents: list) -> list[dict]:
        """Create image content for the model."""
        pass

    @abstractmethod
    def extractResponse(
        self,
        responseObject: Any,
        endTag: str,
        autoConfirmation: bool = False,
    ) -> tuple[str, Any, str]:
        """Extract response text and usage statistics."""
        pass

    @abstractmethod
    def addContinueMessage(
        self,
        messages: list[dict],
        stateRound: AgentStateRound,
        toolState: ToolState,
        agentSetting: AgentSetting,
        agentConfig: AgentConfig,
    ) -> None:
        """Handle continuation for truncated responses."""
        pass

    @abstractmethod
    def initializeOutputAndPrefill(
        self,
        agentConfig: AgentConfig,
        agentSetting: AgentSetting,
        messages: list[dict],
        toolState: ToolState,
        outputFile: str,
        prefill: str,
    ) -> tuple[bool, list[dict]]:
        """Initialize output and handle prefill."""
        pass

    @abstractmethod
    def computePrice(self, responseUsage: Any) -> float:
        """Compute the price for token usage."""
        pass

    @abstractmethod
    def computeResponseUsage(self, responseUsage: Any, responseTime: float) -> Any:
        """Compute model-specific response usage."""
        pass

    @abstractmethod
    def updateMessageContent(
        self,
        messages: list[dict],
        bestConnector: str,
        newResponse: str,
        toolState: ToolState,
        autoConfirmation: bool = False,
    ) -> None:
        """Update message content."""
        pass

    @abstractmethod
    def shouldContinue(self, stopReason: str, newResponse: str, agentSetting: AgentSetting) -> bool:
        """Determine if the model should continue generating based on stop reason and response."""
        pass
