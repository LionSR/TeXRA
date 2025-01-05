"""Base agent class for handling model interactions."""

# Standard library imports
import os
import re
import time
from abc import ABC, abstractmethod
from typing import Any

# Local imports - core
from ..logger import logger

# Local imports - latex utils
from ..latex import (
    extract_and_compile_tikzpictures_with_labels,
    extract_figurePaths_from_latex,
    bestConnectionMethod,
    getTexcountStats,
)

# Local imports - utilities
from ..utils.file import readFile, writeFile, appendFile
from ..utils.prompt import renderPrompt, getListOfFiles, getFirstKCharsFromDocument, write_prompt_to_xml, getXmlFormatFromFiles
from ..utils.replacement import getAllReplacements, applyReplacements, getReplacementsByCategory, applyReplacementRegex
from ..utils.repetition import checkForMassiveRepetition

# Local imports - agent components
from .agent_config import AgentConfig
from .agent_dataclass import AgentSetting, AgentPrompt
from .agent_state import AgentStateRound, AgentStateGlobal
from .tool_state import ToolState
from .logdb import create_log_entry, update_log_statistics, update_log_outputFiles
from .model_handler import ModelHandler
from .output_handler import OutputHandler

K_SLICE = 200


class BaseReflectionAgent(ABC):
    """Abstract base class for reflect chain agents."""

    def __init__(
        self, modelHandler: ModelHandler, agentConfig: AgentConfig, agentSetting: AgentSetting, agentPrompt: AgentPrompt, agentPath: str
    ) -> None:
        self.modelHandler = modelHandler
        self.agentConfig = agentConfig
        self.agentSetting = agentSetting
        self.agentPrompt = agentPrompt
        self.agentPath = agentPath

        logger.debug(f"AgentConfig: {self.agentConfig}\n")
        logger.debug(f"AgentSetting: {self.agentSetting}\n")
        # logger.debug(f"AgentPrompt: {self.agentPrompt}\n")

        logger.debug(f"ModelConfig: {self.modelHandler.config}\n")
        logger.debug(f"ModelHandler: {self.modelHandler}\n")

        # Initialize basic attributes
        self.outputFile = ["", ""]
        self.outputFiles = {0: [], 1: []}
        self.baseFiles = []

        self.setup()
        self.userVars = self.get_userVars()
        self.outputHandler = OutputHandler(self.agentSetting, self.agentConfig, self.modelHandler, self.logId)

    def get_userVars(self) -> dict[str, Any]:
        """Get basic user variables common across agents."""
        # Build user variables incrementally with clear categories
        userVars = {}
        userVars.update(self._get_basic_vars())
        userVars.update(self._get_file_vars())
        userVars.update(self._get_required_file_vars())
        userVars.update(self._get_pattern_based_file_vars())
        userVars.update(self._get_outputFiles_order())
        userVars.update(self._get_toolFlags())
        return userVars

    def _get_basic_vars(self) -> dict[str, Any]:
        """Get basic model and instruction variables."""
        return {
            "MODEL": self.agentConfig.model,
            "MODEL_LIKES_TO_ASK_FOR_CONFIRMATION": self.modelHandler.capabilities.likesToAskForConfirmation,
            "INSTRUCTION": self.agentConfig.instruction,
            "IS_OPENAI_MODEL": self.modelHandler.is_openai,
            "IS_ANTHROPIC_MODEL": self.modelHandler.is_anthropic,
            "IS_GOOGLE_MODEL": self.modelHandler.is_google,
        }

    def _get_file_vars(self) -> dict[str, Any]:
        """Get input, reference, and auxiliary file variables."""
        userVars = {}

        all_inputFiles = [self.agentConfig.inputFile] + (self.agentConfig.inputFiles or [])
        all_referenceFiles = [self.agentConfig.referenceFile] + (self.agentConfig.referenceFiles or [])
        all_auxiliaryFiles = [self.agentConfig.auxiliaryFile] + (self.agentConfig.auxiliaryFiles or [])

        # Handle single files
        singleFileMappings = {
            "INPUT": self.agentConfig.inputFile,
            "REFERENCE": self.agentConfig.referenceFile,
            "AUXILIARY": self.agentConfig.auxiliaryFile,
            "EDITED": self.agentConfig.editedFile,
        }

        for prefix, filePath in singleFileMappings.items():
            userVars[f"{prefix}_FILE"] = filePath
            userVars[f"{prefix}_CONTENT"] = readFile(filePath) if filePath else None

        # Handle file collections
        collectionMappings = {
            "INPUT": (self.agentConfig.inputFiles, all_inputFiles),
            "REFERENCE": (self.agentConfig.referenceFiles, all_referenceFiles),
            "AUXILIARY": (self.agentConfig.auxiliaryFiles, all_auxiliaryFiles),
        }

        for prefix, (additionalFiles, allFiles) in collectionMappings.items():
            userVars[f"ADDITIONAL_{prefix}S"] = getXmlFormatFromFiles(additionalFiles) if additionalFiles else None
            userVars[f"ALL_{prefix}S"] = getXmlFormatFromFiles(allFiles) if allFiles else None
            userVars[f"LIST_OF_ALL_{prefix}S"] = getListOfFiles(allFiles)

        return userVars

    def _get_required_file_vars(self) -> dict[str, Any]:
        """Get variables from required files specified in agent settings."""
        userVars = {}

        # Add variables for required files
        if self.agentSetting.requiredFiles:
            for varName, filePath in self.agentSetting.requiredFiles.items():
                if filePath is not None and os.path.exists(filePath):
                    fileContent = readFile(filePath)
                    userVars[f"{varName}_FILE"] = filePath
                    userVars[f"{varName}_CONTENT"] = fileContent
                    logger.info(f"Found from [requiredFiles] the [VAR '{varName}']: {filePath}")
                else:
                    logger.warning(f"[Required file] {filePath} not found from [VAR '{varName}']")

        # Add variables for internal required files (from prompt directory)
        if self.agentSetting.requiredFilesInternal:
            for varName, filePath in self.agentSetting.requiredFilesInternal.items():
                fullPath = os.path.join(self.agentPath, filePath)
                if os.path.exists(fullPath) and fullPath:
                    fileContent = readFile(fullPath)
                    userVars[f"{varName}_FILE"] = fullPath
                    userVars[f"{varName}_CONTENT"] = fileContent
                    logger.info(f"Found from [requiredFilesInternal] the [VAR '{varName}']: {fullPath}")
                else:
                    logger.warning(f"[Required file internal] {fullPath} not found from [VAR '{varName}']")

        return userVars

    def _get_pattern_based_file_vars(self) -> dict[str, Any]:
        """Get variables from pattern-based file mappings specified in agent settings."""
        userVars = {}

        # Handle pattern-based file mappings if defined in settings
        if self.agentSetting.filePatternsContain:
            for pattern_config in self.agentSetting.filePatternsContain:
                pattern = pattern_config["pattern"].lower()
                varName = pattern_config["varName"]
                categories = pattern_config["categories"]

                # Search in specified categories
                for category in categories:
                    # Get the value from AgentConfig using dictionary-style access
                    category_value = self.agentConfig[category]

                    if category.endswith("_file"):  # Single file categories
                        if category_value and pattern in category_value.lower():
                            if os.path.exists(category_value):
                                fileContent = readFile(category_value)
                                if fileContent:
                                    userVars[varName + "_FILE"] = category_value
                                    userVars[varName + "_CONTENT"] = fileContent
                                    logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{varName}']: {category_value}")
                                else:
                                    logger.warning(f"File {category_value} not found from [Pattern '{pattern}']")
                            else:
                                logger.warning(f"File {category_value} not found from [Pattern '{pattern}']")

                    elif category.endswith("_files"):  # Multiple file categories
                        if category_value:
                            for file in category_value:
                                if pattern in file.lower():
                                    if os.path.exists(file):
                                        fileContent = readFile(file)
                                        if fileContent:
                                            userVars[varName + "_FILE"] = file
                                            userVars[varName + "_CONTENT"] = fileContent
                                            logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{varName}']: {file}")
                                        else:
                                            logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    else:
                                        logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    break  # Stop after first match

        return userVars

    def _get_outputFiles_order(self) -> dict[str, Any]:
        """Get variables for output files order."""
        userVars = {}

        # Handle output files order - use defaultOutputFiles if no outputFiles specified
        if self.agentConfig.outputFiles:
            userVars["OUTPUT_FILES_ORDER"] = ", ".join(self.agentConfig.outputFiles)
        elif hasattr(self.agentSetting, "defaultOutputFiles"):
            # If no outputFiles specified but defaultOutputFiles exists in settings
            self.agentConfig.outputFiles = self.agentSetting.defaultOutputFiles
            userVars["OUTPUT_FILES_ORDER"] = ", ".join(self.agentSetting.defaultOutputFiles)

        return userVars

    def _get_toolFlags(self) -> dict[str, Any]:
        """Get variables related to tool usage flags."""
        return {
            "AUTO_EXTRACT_FIGURE": self.agentConfig.toolConfig.autoExtractFigure,
            "AUTO_EXTRACT_TIKZ_FIGURE": self.agentConfig.toolConfig.autoExtractTikzFigure,
            "AUTO_EXTRACT_TIKZ_FIGURE_REFLECT": self.agentConfig.toolConfig.autoExtractTikzFigureReflect,
            "INCLUDE_TEX_COUNT": self.agentConfig.toolConfig.includeTexCount,
            "AUTO_CONFIRMATION": self.agentConfig.toolConfig.autoConfirmation,
            "USE_PREFILL_FROM_INPUT": self.agentConfig.toolConfig.usePrefillFromInput,
            "PRINT_INPUT_PROMPT": self.agentConfig.toolConfig.printInputPrompt,
            "USE_OPENROUTER": self.agentConfig.toolConfig.useOpenRouter,
        }

    def setup(self):
        """Set up the agent for processing."""
        # Initialize base files and logging
        self.baseFiles = self.agentConfig.outputFiles or [self.agentConfig.inputFile]
        logger.info(f"Processing file: {self.agentConfig.inputFile}")

        # Initialize client and check scratchpad usage
        self.client = self.modelHandler.getClient()

        self.use_scratchpad = "<scratchpad>" in self.agentSetting.prefills if self.agentSetting.prefills else False
        self.outputFile[0] = self.get_outputFile(currRound=0)
        self.outputFile[1] = self.get_outputFile(currRound=1)

        # Initialize logging and database entry
        self.logId = create_log_entry(self.agentConfig, self.agentSetting)

    def handleOutput(
        self,
        stateRound: AgentStateRound,
        stateGlobal: AgentStateGlobal,
        outputFile: str,
        endTurn: bool,
        currRound: int = 0,
    ) -> list[str]:
        """Handle the output for the given round."""
        # Update database with statistics
        if self.logId is not None:
            update_log_statistics(self.logId, stateGlobal, stateRound, currRound)

        update_log_outputFiles(self.logId, outputFile, self.outputHandler.outputFiles[currRound])
        return self.outputHandler.outputFiles[currRound]

    @abstractmethod
    def get_outputFile(self, currRound: int) -> str:
        pass

    def _process_response_cycle(
        self,
        messages: list[dict],
        stateRound: AgentStateRound,
        stateGlobal: AgentStateGlobal,
        toolState: ToolState,
        outputFile: str,
    ) -> tuple[AgentStateRound, AgentStateGlobal, ToolState, bool]:
        """Process a single response cycle."""
        endTurn = False

        while not endTurn:
            fileExists = os.path.exists(outputFile)
            startTime = time.time()
            responseObject = self.modelHandler.createResponse(
                self.client,
                messages,
                self.agentSetting.temperature or 0.0,
                renderPrompt(self.agentPrompt.systemPrompt, self.userVars),
                self.agentSetting.endTag,
            )
            responseTime = time.time() - startTime
            stateRound.updateResponseTime(responseTime)
            logger.info(f"Response time: {responseTime:.2f}s")

            # Extract and validate response
            newResponse, responseUsage, stopReason = self.modelHandler.extract_response(
                responseObject, self.agentSetting.endTag, self.agentConfig.toolConfig.autoConfirmation
            )

            logger.info(f"Stop reason: {stopReason}")
            logger.info(f"Token usage: {responseUsage}")

            # Compute statistics and update states
            APIUsage = self.modelHandler.computeResponseUsage(responseUsage, responseTime)
            stateRound.updateTokenCounts(APIUsage)
            stateGlobal.updateFromCurrRound(stateRound)
            logger.debug(f"State round: {stateRound}")
            logger.debug(f"State global: {stateGlobal}")

            # Early exit for repetition
            # maybe this should be checked with the accumulated output instead of the last response...
            # if the model starts all over again from the beginning, this leads to a bug
            if checkForMassiveRepetition(toolState.lastResponse, newResponse):
                logger.error(f"The new response is: {newResponse}")
                logger.error("Massive repetition detected - skipping this response")
                break

            # Chain response processing operations
            newResponse = (
                applyReplacementRegex(newResponse, getReplacementsByCategory("autoConfirmation"), flags=re.DOTALL | re.MULTILINE)
                if self.modelHandler.capabilities.likesToAskForConfirmation and self.agentConfig.toolConfig.autoConfirmation
                else newResponse
            )
            newResponse = applyReplacements(newResponse, getAllReplacements()).strip()

            toolState.update_lastResponse(newResponse)

            # Process response connection with proper slicing
            bestConnector, _ = bestConnectionMethod(toolState.lastResponse[-K_SLICE:], newResponse[:K_SLICE])

            # Update state and file atomically
            toolState.update_accumulatedOutput(toolState.accumulatedOutput + bestConnector + newResponse)

            # Write or append to output file
            if not fileExists:
                logger.debug(f"Creating new file: {outputFile}")
                writeFile(outputFile, newResponse)
                fileExists = True
            else:
                logger.debug(f"Appending to existing file: {outputFile}")
                appendFile(outputFile, bestConnector + newResponse)

            # Log response boundaries
            logger.info("Response preview:")
            logger.debug(f"First {K_SLICE} chars: {newResponse[:K_SLICE]}")
            logger.debug(f"Last {K_SLICE} chars: {newResponse[-K_SLICE:]}")

            # Update message content
            self.modelHandler.update_message_content(
                messages,
                bestConnector,
                newResponse,
                toolState,
                autoConfirmation=self.agentConfig.toolConfig.autoConfirmation,
            )

            # Check stop conditions
            endTurn, should_stop = self.modelHandler.check_stop_conditions(stopReason, newResponse, stateRound, stateGlobal, self.agentSetting)
            if should_stop:
                break

            # Handle continuation
            stateRound.increment_continuation()
            logger.info(f"Starting continuation #{stateRound.continuationCount}")

            # Check if model should continue generating
            if self.modelHandler.should_continue(stopReason, newResponse, self.agentSetting):
                logger.info("Should continue - adding continuation message to conversation")
                self.modelHandler.add_continue_message(messages, stateRound, toolState, self.agentSetting, self.agentConfig)
                continue

        return stateRound, stateGlobal, toolState, endTurn

    def _get_prefill_for_round(self, currRound: int) -> str:
        """Get prefill content for the current round."""
        prefill = self.agentSetting.prefills[currRound] if currRound < len(self.agentSetting.prefills) else self.agentSetting.prefills[0]
        return prefill if prefill else ""

    def _handle_round_completion(self, stateRound: AgentStateRound, stateGlobal: AgentStateGlobal, outputFile: str, endTurn: bool, currRound: int):
        """Handle output and logging for round completion."""
        self.handleOutput(stateRound, stateGlobal, outputFile, endTurn, currRound=currRound)
        inputInfo = f"input file {self.agentConfig.inputFile} " f"and/or input files {self.agentConfig.inputFiles}"
        logger.info(f"\n\nProcessed {inputInfo}. The round {currRound} output was saved as {outputFile}")
        logger.info(f"Completed round {currRound}")

    def process(self):
        """Process the input files and generate output."""
        # Initialize input files list
        inputFiles = [self.agentConfig.inputFile] + (self.agentConfig.inputFiles or [])
        toolState = ToolState.initialize()

        # Handle tex count if enabled
        if self.agentConfig.toolConfig.includeTexCount:
            toolState.texcountStats = getTexcountStats(inputFiles)

        # Handle prefill from input if enabled
        if self.agentConfig.toolConfig.usePrefillFromInput:
            toolState.firstKCharsFromInput = getFirstKCharsFromDocument(self.agentConfig.inputFile, K_SLICE)

        # Handle figure extraction for vision-capable models
        if self.modelHandler.capabilities.supportsVision:
            if self.agentConfig.figureFile and self.agentConfig.figureFile not in toolState.figureFiles:
                toolState.addFigureFiles([self.agentConfig.figureFile])
            if self.agentConfig.figureFiles:
                toolState.addFigureFiles(self.agentConfig.figureFiles)

            if self.agentConfig.toolConfig.autoExtractFigure:
                # this now only works for single input file. In the future, we should support multiple input files.
                if extracted_figures := extract_figurePaths_from_latex(self.agentConfig.inputFile):
                    toolState.addFigureFiles(extracted_figures)

            if self.agentConfig.toolConfig.autoExtractTikzFigure:
                for inputFile in inputFiles:
                    extractedTikzFigures = extract_and_compile_tikzpictures_with_labels(inputFile)
                    if extractedTikzFigures:
                        toolState.addFigureFiles(extractedTikzFigures)

        # Initialize state and messages
        currRound = 0
        logger.info(f"\n\nProcessing round {currRound}")
        stateGlobal = AgentStateGlobal.initialize()

        messages = []

        # Set up initial prompts
        systemPrompt = renderPrompt(self.agentPrompt.systemPrompt, self.userVars)
        userRequest = renderPrompt(self.agentPrompt.userRequest, self.userVars)
        userPrefix = renderPrompt(self.agentPrompt.userPrefix, self.userVars)

        if toolState.texcountStats:
            userPrefix = f"{toolState.texcountStats}{userPrefix}"

        # Write prompt to file if requested
        if self.agentConfig.toolConfig.printInputPrompt:
            write_prompt_to_xml(systemPrompt, userPrefix, userRequest, self.agentConfig.inputFile, self.agentConfig.agent)

        # Initialize messages with prompts
        messages = self.modelHandler.initialize_messages(
            userPrefix,
            userRequest,
            figureFiles=toolState.figureFiles,
            systemPrompt=systemPrompt,
        )

        # Handle prefill
        prefill = self._get_prefill_for_round(currRound)
        toolState.update_accumulatedOutput(prefill)

        # Initialize output and handle prefill
        endTurn, messages = self.modelHandler.initialize_output_and_prefill(
            self.agentConfig,
            self.agentSetting,
            messages,
            toolState,
            self.outputFile[0],
            prefill,
        )

        stateRound = AgentStateRound.initialize(currRound)
        if not endTurn:
            stateRound, stateGlobal, toolState, endTurn = self._process_response_cycle(
                messages,
                stateRound,
                stateGlobal,
                toolState,
                self.outputFile[0],
            )

        # Handle output and logging
        self._handle_round_completion(stateRound, stateGlobal, self.outputFile[0], endTurn, currRound)

        return stateRound, stateGlobal, messages, endTurn, toolState

    def __handleToolStateForOutput(self, outputFiles: list[str], currRound: int, toolState: ToolState):
        """Helper method to handle tex count and TikZ figure extraction for output files."""
        if self.agentConfig.toolConfig.includeTexCount:
            toolState.texcountStats = getTexcountStats(outputFiles)

        if self.modelHandler.capabilities.supportsVision and self.agentConfig.toolConfig.autoExtractTikzFigureReflect:
            for outputFile in outputFiles:
                logger.debug(f"Extracting TikZ figures from {outputFile}")
                if extractedTikzFigures := extract_and_compile_tikzpictures_with_labels(outputFile):
                    toolState.addFigureFiles(extractedTikzFigures)

    def reflect(self, stateGlobal: AgentStateGlobal, messages: list[dict], toolState: ToolState, currRound: int = 1):
        """Process reflection round."""
        # Handle output file processing
        if self.agentConfig.outputFiles:
            self.__handleToolStateForOutput(self.agentConfig.outputFiles, currRound, toolState)
        else:
            # Handle single output file
            generatedOutputFile = self.outputHandler.outputFiles[0][0]
            self.__handleToolStateForOutput([generatedOutputFile], currRound, toolState)

        if self.agentConfig.toolConfig.usePrefillFromInput:
            toolState.firstKCharsFromInput = getFirstKCharsFromDocument(self.agentConfig.inputFile, K_SLICE)

        # Initialize reflection round
        logger.info(f"\n\nProcessing round {currRound}")
        stateRound = AgentStateRound.initialize(currRound)

        # Prepare reflection message
        userRequestReflection = renderPrompt(self.agentPrompt.userReflect, self.userVars)
        userMessage = f"{userRequestReflection}\n" if userRequestReflection else ""
        if toolState.texcountStats:
            userMessage = f"{toolState.texcountStats}{userMessage}"

        # Only proceed if there's actual content
        if not userMessage.strip():
            return stateRound, stateGlobal, messages, True

        messages = self.modelHandler.create_reflection_messages(messages, userMessage, toolState.figureFiles)

        # Handle prefill for reflection round
        prefill = self._get_prefill_for_round(currRound)
        toolState.update_accumulatedOutput(prefill)

        endTurn, messages = self.modelHandler.initialize_output_and_prefill(
            self.agentConfig,
            self.agentSetting,
            messages,
            toolState,
            self.outputFile[1],
            prefill,
        )

        if not endTurn:
            stateRound, stateGlobal, toolState, endTurn = self._process_response_cycle(
                messages,
                stateRound,
                stateGlobal,
                toolState,
                self.outputFile[1],
            )

        # Handle output and logging
        self._handle_round_completion(stateRound, stateGlobal, self.outputFile[1], endTurn, currRound)

        return stateRound, stateGlobal, messages, endTurn

    def run(self):
        """Run the agent processing pipeline."""
        stateRound, stateGlobal, messages, endTurn, toolState = self.process()

        if self.agentConfig.reflect and endTurn:
            # Create a new ToolState for reflection round
            toolStateReflection = ToolState.initialize()
            stateRoundReflection, stateGlobalReflection, messagesReflection, endTurnReflection = self.reflect(
                stateGlobal, messages, toolStateReflection
            )

    def _process_outputFiles(self, outputFile: str, currRound: int):
        """Process output files for the current round.

        Handles both single and multiple output file cases, including:
        - Processing outputs
        - Handling file operations
        - Managing output file tracking
        - Handling LaTeX diff if needed
        """
        if self.agentConfig.outputFiles:
            processedFiles = self.outputHandler._processMultipleOutputs(outputFile)
            self.outputHandler._handleMultipleOutputs(processedFiles)
            self.outputHandler.outputFiles[currRound] = processedFiles
            self.outputHandler._replaceInputCommands(self.baseFiles, processedFiles)
        else:
            processedFile = self.outputHandler._processSingleOutput(outputFile)
            self.outputHandler._handleSingleOutput(processedFile)
            self.outputHandler.outputFiles[currRound] = [processedFile]

        self.outputHandler._handleLatexdiff(currRound)
