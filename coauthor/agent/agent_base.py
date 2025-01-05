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
    extract_figure_paths_from_latex,
    best_connection_method,
    get_texcountStats,
)

# Local imports - utilities
from ..utils.file import read_file, write_file, append_file
from ..utils.prompt import render_prompt, get_list_of_files, get_first_k_chars_from_document, write_prompt_to_xml
from ..utils.replacement import get_all_replacements, applyReplacements, get_replacements_by_category, apply_replacement_regex
from ..utils.repetition import check_for_massive_repetition
from ..utils.xml import get_xml_format_from_files

# Local imports - agent components
from .agent_config import AgentConfig
from .agent_dataclass import AgentSettings, AgentPrompts
from .agent_state import AgentStateRound, AgentStateGlobal
from .tool_state import ToolState
from .logdb import create_log_entry, update_log_statistics, update_log_outputFiles
from .model_handler import ModelHandler
from .output_handler import OutputHandler

K_SLICE = 200


class BaseReflectionAgent(ABC):
    """Abstract base class for reflect chain agents."""

    def __init__(
        self, modelHandler: ModelHandler, agentConfig: AgentConfig, agentSettings: AgentSettings, agentPrompts: AgentPrompts, agentPath: str
    ) -> None:
        self.modelHandler = modelHandler
        self.agentConfig = agentConfig
        self.agentSettings = agentSettings
        self.agentPrompts = agentPrompts
        self.agentPath = agentPath

        logger.debug(f"AgentConfig: {self.agentConfig}\n")
        logger.debug(f"AgentSettings: {self.agentSettings}\n")
        # logger.debug(f"AgentPrompts: {self.agentPrompts}\n")

        logger.debug(f"ModelConfig: {self.modelHandler.config}\n")
        logger.debug(f"ModelHandler: {self.modelHandler}\n")

        # Initialize basic attributes
        self.outputFile = ["", ""]
        self.outputFiles = {0: [], 1: []}
        self.baseFiles = []

        self.setup()
        self.user_vars = self.get_user_vars()
        self.output_handler = OutputHandler(self.agentSettings, self.agentConfig, self.modelHandler, self.logId)

    def get_user_vars(self) -> dict[str, Any]:
        """Get basic user variables common across agents."""
        # Build user variables incrementally with clear categories
        user_vars = {}
        user_vars.update(self._get_basic_vars())
        user_vars.update(self._get_file_vars())
        user_vars.update(self._get_required_file_vars())
        user_vars.update(self._get_pattern_based_file_vars())
        user_vars.update(self._get_outputFiles_order())
        user_vars.update(self._get_toolFlags())
        return user_vars

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
        user_vars = {}

        all_inputFiles = [self.agentConfig.inputFile] + (self.agentConfig.inputFiles or [])
        all_referenceFiles = [self.agentConfig.referenceFile] + (self.agentConfig.referenceFiles or [])
        all_auxiliaryFiles = [self.agentConfig.auxiliaryFile] + (self.agentConfig.auxiliaryFiles or [])

        # Handle single files
        single_file_mappings = {
            "INPUT": self.agentConfig.inputFile,
            "REFERENCE": self.agentConfig.referenceFile,
            "AUXILIARY": self.agentConfig.auxiliaryFile,
            "EDITED": self.agentConfig.editedFile,
        }

        for prefix, filePath in single_file_mappings.items():
            user_vars[f"{prefix}_FILE"] = filePath
            user_vars[f"{prefix}_CONTENT"] = read_file(filePath) if filePath else None

        # Handle file collections
        collection_mappings = {
            "INPUT": (self.agentConfig.inputFiles, all_inputFiles),
            "REFERENCE": (self.agentConfig.referenceFiles, all_referenceFiles),
            "AUXILIARY": (self.agentConfig.auxiliaryFiles, all_auxiliaryFiles),
        }

        for prefix, (additional_files, all_files) in collection_mappings.items():
            user_vars[f"ADDITIONAL_{prefix}S"] = get_xml_format_from_files(additional_files) if additional_files else None
            user_vars[f"ALL_{prefix}S"] = get_xml_format_from_files(all_files) if all_files else None
            user_vars[f"LIST_OF_ALL_{prefix}S"] = get_list_of_files(all_files)

        return user_vars

    def _get_required_file_vars(self) -> dict[str, Any]:
        """Get variables from required files specified in agent settings."""
        user_vars = {}

        # Add variables for required files
        if self.agentSettings.requiredFiles:
            for varName, filePath in self.agentSettings.requiredFiles.items():
                if filePath is not None and os.path.exists(filePath):
                    fileContent = read_file(filePath)
                    user_vars[f"{varName}_FILE"] = filePath
                    user_vars[f"{varName}_CONTENT"] = fileContent
                    logger.info(f"Found from [requiredFiles] the [VAR '{varName}']: {filePath}")
                else:
                    logger.warning(f"[Required file] {filePath} not found from [VAR '{varName}']")

        # Add variables for internal required files (from prompt directory)
        if self.agentSettings.requiredFilesInternal:
            for varName, filePath in self.agentSettings.requiredFilesInternal.items():
                full_path = os.path.join(self.agentPath, filePath)
                if os.path.exists(full_path) and full_path:
                    fileContent = read_file(full_path)
                    user_vars[f"{varName}_FILE"] = full_path
                    user_vars[f"{varName}_CONTENT"] = fileContent
                    logger.info(f"Found from [requiredFilesInternal] the [VAR '{varName}']: {full_path}")
                else:
                    logger.warning(f"[Required file internal] {full_path} not found from [VAR '{varName}']")

        return user_vars

    def _get_pattern_based_file_vars(self) -> dict[str, Any]:
        """Get variables from pattern-based file mappings specified in agent settings."""
        user_vars = {}

        # Handle pattern-based file mappings if defined in settings
        if self.agentSettings.filePatternsContain:
            for pattern_config in self.agentSettings.filePatternsContain:
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
                                fileContent = read_file(category_value)
                                if fileContent:
                                    user_vars[varName + "_FILE"] = category_value
                                    user_vars[varName + "_CONTENT"] = fileContent
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
                                        fileContent = read_file(file)
                                        if fileContent:
                                            user_vars[varName + "_FILE"] = file
                                            user_vars[varName + "_CONTENT"] = fileContent
                                            logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{varName}']: {file}")
                                        else:
                                            logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    else:
                                        logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    break  # Stop after first match

        return user_vars

    def _get_outputFiles_order(self) -> dict[str, Any]:
        """Get variables for output files order."""
        user_vars = {}

        # Handle output files order - use defaultOutputFiles if no outputFiles specified
        if self.agentConfig.outputFiles:
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.agentConfig.outputFiles)
        elif hasattr(self.agentSettings, "defaultOutputFiles"):
            # If no outputFiles specified but defaultOutputFiles exists in settings
            self.agentConfig.outputFiles = self.agentSettings.defaultOutputFiles
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.agentSettings.defaultOutputFiles)

        return user_vars

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
        self.client = self.modelHandler.get_client()

        self.use_scratchpad = "<scratchpad>" in self.agentSettings.prefills if self.agentSettings.prefills else False
        self.outputFile[0] = self.get_outputFile(currRound=0)
        self.outputFile[1] = self.get_outputFile(currRound=1)

        # Initialize logging and database entry
        self.logId = create_log_entry(self.agentConfig, self.agentSettings)

    def handle_output(
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

        update_log_outputFiles(self.logId, outputFile, self.output_handler.outputFiles[currRound])
        return self.output_handler.outputFiles[currRound]

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
            file_exists = os.path.exists(outputFile)
            start_time = time.time()
            responseObject = self.modelHandler.create_response(
                self.client,
                messages,
                self.agentSettings.temperature or 0.0,
                render_prompt(self.agentPrompts.systemPrompt, self.user_vars),
                self.agentSettings.endTag,
            )
            responseTime = time.time() - start_time
            stateRound.update_responseTime(responseTime)
            logger.info(f"Response time: {responseTime:.2f}s")

            # Extract and validate response
            newResponse, responseUsage, stopReason = self.modelHandler.extract_response(
                responseObject, self.agentSettings.endTag, self.agentConfig.toolConfig.autoConfirmation
            )

            logger.info(f"Stop reason: {stopReason}")

            logger.info(f"Token usage: {responseUsage}")

            # Compute statistics and update states
            APIUsage = self.modelHandler.compute_response_usage(responseUsage, responseTime)
            stateRound.update_token_counts(APIUsage)
            stateGlobal.update_from_currRound(stateRound)
            logger.debug(f"State round: {stateRound}")
            logger.debug(f"State global: {stateGlobal}")

            # Early exit for repetition
            # maybe this should be checked with the accumulated output instead of the last response...
            # if the model starts all over again from the beginning, this leads to a bug
            if check_for_massive_repetition(toolState.lastResponse, newResponse):
                logger.error(f"The new response is: {newResponse}")
                logger.error("Massive repetition detected - skipping this response")
                break

            # Chain response processing operations
            newResponse = (
                apply_replacement_regex(newResponse, get_replacements_by_category("autoConfirmation"), flags=re.DOTALL | re.MULTILINE)
                if self.modelHandler.capabilities.likesToAskForConfirmation and self.agentConfig.toolConfig.autoConfirmation
                else newResponse
            )
            newResponse = applyReplacements(newResponse, get_all_replacements()).strip()

            toolState.update_lastResponse(newResponse)

            # Process response connection with proper slicing
            bestConnector, _ = best_connection_method(toolState.lastResponse[-K_SLICE:], newResponse[:K_SLICE])

            # Update state and file atomically
            toolState.update_accumulatedOutput(toolState.accumulatedOutput + bestConnector + newResponse)

            # Write or append to output file
            if not file_exists:
                logger.debug(f"Creating new file: {outputFile}")
                write_file(outputFile, newResponse)
                file_exists = True
            else:
                logger.debug(f"Appending to existing file: {outputFile}")
                append_file(outputFile, bestConnector + newResponse)

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
            endTurn, should_stop = self.modelHandler.check_stop_conditions(stopReason, newResponse, stateRound, stateGlobal, self.agentSettings)
            if should_stop:
                break

            # Handle continuation
            stateRound.increment_continuation()
            logger.info(f"Starting continuation #{stateRound.continuationCount}")

            # Check if model should continue generating
            if self.modelHandler.should_continue(stopReason, newResponse, self.agentSettings):
                logger.info("Should continue - adding continuation message to conversation")
                self.modelHandler.add_continue_message(messages, stateRound, toolState, self.agentSettings, self.agentConfig)
                continue

        return stateRound, stateGlobal, toolState, endTurn

    def _get_prefill_for_round(self, currRound: int) -> str:
        """Get prefill content for the current round."""
        prefill = self.agentSettings.prefills[currRound] if currRound < len(self.agentSettings.prefills) else self.agentSettings.prefills[0]
        return prefill if prefill else ""

    def _handle_round_completion(self, stateRound: AgentStateRound, stateGlobal: AgentStateGlobal, outputFile: str, endTurn: bool, currRound: int):
        """Handle output and logging for round completion."""
        self.handle_output(stateRound, stateGlobal, outputFile, endTurn, currRound=currRound)
        input_info = f"input file {self.agentConfig.inputFile} " f"and/or input files {self.agentConfig.inputFiles}"
        logger.info(f"\n\nProcessed {input_info}. The round {currRound} output was saved as {outputFile}")
        logger.info(f"Completed round {currRound}")

    def process(self):
        """Process the input files and generate output."""
        # Initialize input files list
        inputFiles = [self.agentConfig.inputFile] + (self.agentConfig.inputFiles or [])
        toolState = ToolState.initialize()

        # Handle tex count if enabled
        if self.agentConfig.toolConfig.includeTexCount:
            toolState.texcountStats = get_texcountStats(inputFiles)

        # Handle prefill from input if enabled
        if self.agentConfig.toolConfig.usePrefillFromInput:
            toolState.firstKCharsFromInput = get_first_k_chars_from_document(self.agentConfig.inputFile, K_SLICE)

        # Handle figure extraction for vision-capable models
        if self.modelHandler.capabilities.supportsVision:
            if self.agentConfig.figureFile and self.agentConfig.figureFile not in toolState.figureFiles:
                toolState.add_figureFiles([self.agentConfig.figureFile])
            if self.agentConfig.figureFiles:
                toolState.add_figureFiles(self.agentConfig.figureFiles)

            if self.agentConfig.toolConfig.autoExtractFigure:
                # this now only works for single input file. In the future, we should support multiple input files.
                if extracted_figures := extract_figure_paths_from_latex(self.agentConfig.inputFile):
                    toolState.add_figureFiles(extracted_figures)

            if self.agentConfig.toolConfig.autoExtractTikzFigure:
                for inputFile in inputFiles:
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(inputFile)
                    if extracted_tikz_figures:
                        toolState.add_figureFiles(extracted_tikz_figures)

        # Initialize state and messages
        currRound = 0
        logger.info(f"\n\nProcessing round {currRound}")
        stateGlobal = AgentStateGlobal.initialize()

        messages = []

        # Set up initial prompts
        systemPrompt = render_prompt(self.agentPrompts.systemPrompt, self.user_vars)
        userRequest = render_prompt(self.agentPrompts.userRequest, self.user_vars)
        userPrefix = render_prompt(self.agentPrompts.userPrefix, self.user_vars)

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
            self.agentSettings,
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

    def _handle_outputFile_processing(self, outputFiles: list[str], currRound: int, toolState: ToolState):
        """Helper method to handle tex count and TikZ figure extraction for output files."""
        if self.agentConfig.toolConfig.includeTexCount:
            toolState.texcountStats = get_texcountStats(outputFiles)

        if self.modelHandler.capabilities.supportsVision and self.agentConfig.toolConfig.autoExtractTikzFigureReflect:
            for outputFile in outputFiles:
                logger.debug(f"Extracting TikZ figures from {outputFile}")
                if extracted_tikz_figures := extract_and_compile_tikzpictures_with_labels(outputFile):
                    toolState.add_figureFiles(extracted_tikz_figures)

    def reflect(self, stateGlobal: AgentStateGlobal, messages: list[dict], toolState: ToolState, currRound: int = 1):
        """Process reflection round."""
        # Handle output file processing
        if self.agentConfig.outputFiles:
            self._handle_outputFile_processing(self.agentConfig.outputFiles, currRound, toolState)
        else:
            # Handle single output file
            generated_outputFile = self.output_handler.outputFiles[0][0]
            self._handle_outputFile_processing([generated_outputFile], currRound, toolState)

        if self.agentConfig.toolConfig.usePrefillFromInput:
            toolState.firstKCharsFromInput = get_first_k_chars_from_document(self.agentConfig.inputFile, K_SLICE)

        # Initialize reflection round
        logger.info(f"\n\nProcessing round {currRound}")
        stateRound = AgentStateRound.initialize(currRound)

        # Prepare reflection message
        userRequest_reflect = render_prompt(self.agentPrompts.userReflect, self.user_vars)
        userMessage = f"{userRequest_reflect}\n" if userRequest_reflect else ""
        if toolState.texcountStats:
            userMessage = f"{toolState.texcountStats}{userMessage}"

        # Only proceed if there's actual content
        if not userMessage.strip():
            return stateRound, stateGlobal, messages, True

        messages = self.modelHandler.create_reflection_message(messages, userMessage, toolState.figureFiles)

        # Handle prefill for reflection round
        prefill = self._get_prefill_for_round(currRound)
        toolState.update_accumulatedOutput(prefill)

        endTurn, messages = self.modelHandler.initialize_output_and_prefill(
            self.agentConfig,
            self.agentSettings,
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
            reflection_toolState = ToolState.initialize()
            reflection_stateRound, stateGlobal, reflection_messages, endTurn_reflection = self.reflect(stateGlobal, messages, reflection_toolState)

    def _process_outputFiles(self, outputFile: str, currRound: int):
        """Process output files for the current round.

        Handles both single and multiple output file cases, including:
        - Processing outputs
        - Handling file operations
        - Managing output file tracking
        - Handling LaTeX diff if needed
        """
        if self.agentConfig.outputFiles:
            processedFiles = self.output_handler._process_multiple_outputs(outputFile)
            self.output_handler._handle_multiple_outputs(processedFiles)
            self.output_handler.outputFiles[currRound] = processedFiles
            self.output_handler._replace_input_commands(self.baseFiles, processedFiles)
        else:
            processed_file = self.output_handler._process_single_output(outputFile)
            self.output_handler._handle_single_output(processed_file)
            self.output_handler.outputFiles[currRound] = [processed_file]

        self.output_handler._handle_latexdiff(currRound)
