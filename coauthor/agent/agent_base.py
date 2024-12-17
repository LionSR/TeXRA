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
    get_tex_count_stats,
)

# Local imports - utilities
from ..utils.file import read_file, write_to_output_file
from ..utils.prompt import render_prompt, get_list_of_files, get_first_k_from_document
from ..utils.replacement import get_all_replacements, apply_replacements, get_replacements_by_category, apply_replacement_regex
from ..utils.repetition import check_for_massive_repetition
from ..utils.xml import get_xml_format_from_files

# Local imports - agent components
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_state import AgentRoundState, AgentGlobalState
from .tool_handler import ToolState
from .logdb import create_log_entry, update_log_statistics, update_log_output_files
from .model_base import ModelHandler
from .output_handler import OutputHandler


class BaseReflectChainAgent(ABC):
    """Abstract base class for reflect chain agents."""

    def __init__(
        self, model_handler: ModelHandler, agent_config: AgentConfig, agent_settings: AgentSettings, agent_prompts: AgentPrompts, agent_path: str
    ) -> None:
        self.model_handler = model_handler
        self.agent_config = agent_config
        self.agent_settings = agent_settings
        self.agent_prompts = agent_prompts
        self.agent_path = agent_path

        logger.debug(f"Model handler: {self.model_handler}")
        logger.debug(f"Agent config: {self.agent_config}")
        logger.debug(f"Agent settings: {self.agent_settings}")

        # Initialize basic attributes
        self.output_file = ["", ""]
        self.output_files = {0: [], 1: []}
        self.base_files = []

        self.setup()
        self.user_vars = self.get_user_vars()
        self.output_handler = OutputHandler(self.agent_settings, self.agent_config, self.model_handler, self.log_id)

    def get_user_vars(self) -> dict[str, Any]:
        """Get basic user variables common across agents."""
        # Build user variables incrementally with clear categories
        user_vars = {}
        user_vars.update(self._get_basic_vars())
        user_vars.update(self._get_file_vars())
        user_vars.update(self._get_required_file_vars())
        user_vars.update(self._get_pattern_based_file_vars())
        user_vars.update(self._get_output_files_order())
        user_vars.update(self._get_tool_flags())
        return user_vars

    def _get_basic_vars(self) -> dict[str, Any]:
        """Get basic model and instruction variables."""
        return {
            "MODEL": self.agent_config.model,
            "MODEL_LIKES_TO_ASK_FOR_CONFIRMATION": self.model_handler.capabilities.likes_to_ask_for_confirmation,
            "INSTRUCTION": self.agent_config.instruction,
        }

    def _get_file_vars(self) -> dict[str, Any]:
        """Get input, reference, and auxiliary file variables."""
        user_vars = {}

        all_input_files = [self.agent_config.input_file] + (self.agent_config.input_files or [])
        all_reference_files = [self.agent_config.reference_file] + (self.agent_config.reference_files or [])
        all_auxiliary_files = [self.agent_config.auxiliary_file] + (self.agent_config.auxiliary_files or [])

        # Handle single files
        single_file_mappings = {
            "INPUT": self.agent_config.input_file,
            "REFERENCE": self.agent_config.reference_file,
            "AUXILIARY": self.agent_config.auxiliary_file,
            "EDITED": self.agent_config.edited_file,
        }

        for prefix, file_path in single_file_mappings.items():
            user_vars[f"{prefix}_FILE"] = file_path
            user_vars[f"{prefix}_CONTENT"] = read_file(file_path) if file_path else None

        # Handle file collections
        collection_mappings = {
            "INPUT": (self.agent_config.input_files, all_input_files),
            "REFERENCE": (self.agent_config.reference_files, all_reference_files),
            "AUXILIARY": (self.agent_config.auxiliary_files, all_auxiliary_files),
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
        if self.agent_settings.required_files:
            for var_name, file_path in self.agent_settings.required_files.items():
                if file_path is not None and os.path.exists(file_path):
                    file_content = read_file(file_path)
                    user_vars[f"{var_name}_FILE"] = file_path
                    user_vars[f"{var_name}_CONTENT"] = file_content
                    logger.info(f"Found from [Required Files] the [VAR '{var_name}']: {file_path}")
                else:
                    logger.warning(f"[Required file] {file_path} not found from [VAR '{var_name}']")

        # Add variables for internal required files (from prompt directory)
        if self.agent_settings.required_files_internal:
            for var_name, file_path in self.agent_settings.required_files_internal.items():
                full_path = os.path.join(self.agent_path, file_path)
                if os.path.exists(full_path) and full_path:
                    file_content = read_file(full_path)
                    user_vars[f"{var_name}_FILE"] = full_path
                    user_vars[f"{var_name}_CONTENT"] = file_content
                    logger.info(f"Found from [Required Files Internal] the [VAR '{var_name}']: {full_path}")
                else:
                    logger.warning(f"[Required file internal] {full_path} not found from [VAR '{var_name}']")

        return user_vars

    def _get_pattern_based_file_vars(self) -> dict[str, Any]:
        """Get variables from pattern-based file mappings specified in agent settings."""
        user_vars = {}

        # Handle pattern-based file mappings if defined in settings
        if self.agent_settings.file_patterns_contain:
            for pattern_config in self.agent_settings.file_patterns_contain:
                pattern = pattern_config["pattern"].lower()
                var_name = pattern_config["var_name"]
                categories = pattern_config["categories"]

                # Search in specified categories
                for category in categories:
                    # Get the value from AgentConfig using dictionary-style access
                    category_value = self.agent_config[category]

                    if category.endswith("_file"):  # Single file categories
                        if category_value and pattern in category_value.lower():
                            if os.path.exists(category_value):
                                file_content = read_file(category_value)
                                if file_content:
                                    user_vars[var_name + "_FILE"] = category_value
                                    user_vars[var_name + "_CONTENT"] = file_content
                                    logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{var_name}']: {category_value}")
                                else:
                                    logger.warning(f"File {category_value} not found from [Pattern '{pattern}']")
                            else:
                                logger.warning(f"File {category_value} not found from [Pattern '{pattern}']")

                    elif category.endswith("_files"):  # Multiple file categories
                        if category_value:
                            for file in category_value:
                                if pattern in file.lower():
                                    if os.path.exists(file):
                                        file_content = read_file(file)
                                        if file_content:
                                            user_vars[var_name + "_FILE"] = file
                                            user_vars[var_name + "_CONTENT"] = file_content
                                            logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{var_name}']: {file}")
                                        else:
                                            logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    else:
                                        logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    break  # Stop after first match

        return user_vars

    def _get_output_files_order(self) -> dict[str, Any]:
        """Get variables for output files order."""
        user_vars = {}

        # Handle output files order - use default_output_files if no output_files specified
        if self.agent_config.output_files:
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.agent_config.output_files)
        elif hasattr(self.agent_settings, "default_output_files"):
            # If no output_files specified but default_output_files exists in settings
            self.agent_config.output_files = self.agent_settings.default_output_files
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.agent_settings.default_output_files)

        return user_vars

    def _get_tool_flags(self) -> dict[str, Any]:
        """Get variables related to tool usage flags."""
        # Use direct attribute access for cleaner code
        config = self.agent_config
        return {
            "AUTO_CONFIRMATION": config.auto_confirmation,
            "USE_PREFILL_FROM_INPUT": config.use_prefill_from_input,
            "AUTO_EXTRACT_FIGURE": config.auto_extract_figure,
            "AUTO_EXTRACT_TIKZ_FIGURE": config.auto_extract_tikz_figure,
            "AUTO_EXTRACT_TIKZ_FIGURE_REFLECT": config.auto_extract_tikz_figure_reflect,
            "INCLUDE_TEX_COUNT": config.include_tex_count,
        }

    def setup(self):
        """Set up the agent for processing."""
        # Initialize base files and logging
        self.base_files = self.agent_config.output_files or [self.agent_config.input_file]
        logger.info(f"Processing file: {self.agent_config.input_file}")

        # Initialize client and check scratchpad usage
        self.client = self.model_handler.get_client()

        self.use_scratchpad = "<scratchpad>" in self.agent_settings.prefills if self.agent_settings.prefills else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)

        # Initialize logging and database entry
        self.log_id = create_log_entry(self.agent_config, self.agent_settings)

    def handle_output(
        self,
        round_state: AgentRoundState,
        global_state: AgentGlobalState,
        output_file: str,
        end_turn: bool,
        round: int = 0,
    ) -> list[str]:
        """Handle the output for the given round."""
        # Update database with statistics
        if self.log_id is not None:
            update_log_statistics(self.log_id, global_state, round_state, round)

        update_log_output_files(self.log_id, output_file, self.output_handler.output_files[round])
        return self.output_handler.output_files[round]

    @abstractmethod
    def get_output_file(self, round: int) -> str:
        pass

    def _process_response_cycle(
        self,
        messages: list[dict[str, Any]],
        round_state: AgentRoundState,
        global_state: AgentGlobalState,
        tool_state: ToolState,
        output_file: str,
    ) -> tuple[AgentRoundState, AgentGlobalState, ToolState, bool]:
        """Process a single response cycle."""
        end_turn = False

        while not end_turn:
            file_exists = os.path.exists(output_file)
            start_time = time.time()
            response_object = self.model_handler.create_response(
                self.client,
                messages,
                self.agent_settings.temperature or 0.0,
                render_prompt(self.agent_prompts.system_prompt, self.user_vars),
                self.agent_settings.end_tag,
            )
            response_time = time.time() - start_time
            round_state.update_response_time(response_time)
            logger.info(f"Response time: {response_time:.2f}s")

            # Extract and validate response
            new_response, response_usage, stop_reason = self.model_handler.extract_response(
                response_object, self.agent_settings.end_tag, self.agent_config.auto_confirmation
            )

            # Compute statistics and update states
            model_usage = self.model_handler.compute_statistics(response_usage, response_time)
            round_state.update_token_counts(model_usage)
            global_state.update_from_round(round_state)

            logger.info(f"Stop reason: {stop_reason}")
            logger.info(f"Token usage: {response_object.usage}")

            # Early exit for repetition
            if check_for_massive_repetition(tool_state.last_response, new_response):
                logger.error(f"The new response is: {new_response}")
                logger.error("Massive repetition detected - skipping this response")
                break

            # Chain response processing operations
            new_response = (
                apply_replacement_regex(new_response, get_replacements_by_category("lazy"), flags=re.DOTALL | re.MULTILINE)
                if self.model_handler.capabilities.likes_to_ask_for_confirmation and self.agent_config.auto_confirmation
                else new_response
            )
            new_response = apply_replacements(new_response, get_all_replacements()).strip()

            tool_state.update_last_response(new_response)

            # Process response connection with proper slicing
            k_slice = self.agent_config.K
            best_connector, _ = best_connection_method(tool_state.last_response[-k_slice:], new_response[:k_slice])

            # Update state and file atomically
            tool_state.update_accumulated_output(tool_state.accumulated_output + best_connector + new_response)
            file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)

            # Log response boundaries
            logger.info("Response preview:")
            logger.debug(f"First {k_slice} chars: {new_response[:k_slice]}")
            logger.debug(f"Last {k_slice} chars: {new_response[-k_slice:]}")

            # Update message content
            self.model_handler.update_message_content(messages, best_connector, new_response, tool_state)

            # Check stop conditions
            end_turn, should_stop = self.model_handler.check_stop_conditions(stop_reason, new_response, round_state, global_state, self.agent_settings)
            if should_stop:
                break

            # Handle continuation
            round_state.increment_continuation()
            logger.info(f"Starting continuation #{round_state.continuation_count}")

            if self.model_handler.is_openai_compatible:
                if stop_reason == "length" and not self.agent_settings.has_end_tag(new_response):
                    self.model_handler.handle_continuation(messages, round_state, tool_state, self.agent_settings, self.agent_config)
                    continue

            if self.model_handler.is_anthropic and self.model_handler.capabilities.likes_to_ask_for_confirmation:
                if stop_reason != "max_tokens" and stop_reason != "stop_sequence" and not self.agent_settings.has_end_tag(new_response):
                    end_turn = False
                    self.model_handler.handle_continuation(messages, round_state, tool_state, self.agent_settings, self.agent_config)
                    continue

        return round_state, global_state, tool_state, end_turn

    def process_first_round(
        self,
        messages: list[dict[str, Any]],
        user_vars: dict[str, str],
        global_state: AgentGlobalState,
        tool_state: ToolState,
        output_file: str,
        round: int = 0,
    ) -> tuple[AgentRoundState, AgentGlobalState, ToolState, bool, list[dict[str, Any]]]:
        """Process the first round."""
        logger.info(f"\n\nProcessing round {round}")

        system_prompt = render_prompt(self.agent_prompts.system_prompt, user_vars)
        user_request = render_prompt(self.agent_prompts.user_request, user_vars)
        user_prefix = render_prompt(self.agent_prompts.user_prefix, user_vars)

        if tool_state.tex_count_stats:
            user_prefix = f"{tool_state.tex_count_stats}{user_prefix}"

        messages = self.model_handler.initialize_messages(
            user_prefix,
            user_request,
            figure_files=tool_state.figure_files,
            system_prompt=system_prompt,
        )

        prefill = self.agent_settings.prefills[round] if round < len(self.agent_settings.prefills) else self.agent_settings.prefills[0]
        tool_state.update_accumulated_output(prefill if prefill else "")

        end_turn, messages = self.model_handler.initialize_output_and_prefill(
            self.agent_config,
            self.agent_settings,
            messages,
            tool_state,
            output_file,
            prefill,
        )

        if end_turn:
            round_state = AgentRoundState.initialize(round)
            return round_state, global_state, tool_state, end_turn, messages

        round_state = AgentRoundState.initialize(round)

        round_state, global_state, tool_state, end_turn = self._process_response_cycle(
            messages,
            round_state,
            global_state,
            tool_state,
            output_file,
        )

        return round_state, global_state, tool_state, end_turn, messages

    def process_reflection_round(
        self,
        messages: list[dict[str, Any]],
        user_vars: dict[str, str],
        global_state: AgentGlobalState,
        tool_state: ToolState,
        output_file: str,
        round: int = 1,
    ) -> tuple[AgentRoundState, AgentGlobalState, ToolState, bool, list[dict[str, Any]]]:
        """Process the reflection round."""
        logger.info(f"\n\nProcessing round {round}")

        round_state = AgentRoundState.initialize(round)

        user_request_reflect = render_prompt(self.agent_prompts.user_reflect, user_vars)
        user_message = f"{user_request_reflect}\n" if user_request_reflect else ""
        if tool_state.tex_count_stats:
            user_message = f"{tool_state.tex_count_stats}{user_message}"

        # Only create reflection message if there's actual content
        if user_message.strip():
            messages = self.model_handler.create_reflection_message(messages, user_message, tool_state.figure_files)
        else:
            return round_state, global_state, tool_state, True, messages

        prefill = self.agent_settings.prefills[round] if round < len(self.agent_settings.prefills) else self.agent_settings.prefills[0]
        tool_state.update_accumulated_output(prefill if prefill else "")

        end_turn, messages = self.model_handler.initialize_output_and_prefill(
            self.agent_config,
            self.agent_settings,
            messages,
            tool_state,
            output_file,
            prefill,
        )

        if end_turn:
            round_state = AgentRoundState.initialize(round)
            return round_state, global_state, tool_state, end_turn, messages

        round_state, global_state, tool_state, end_turn = self._process_response_cycle(
            messages,
            round_state,
            global_state,
            tool_state,
            output_file,
        )

        return round_state, global_state, tool_state, end_turn, messages

    def process(self):
        """Process the input files and generate output."""
        # Initialize input files list
        input_files = [self.agent_config.input_file] + (self.agent_config.input_files or [])
        tool_state = ToolState.initialize()

        # Handle tex count if enabled
        if self.agent_config.include_tex_count:
            tool_state.tex_count_stats = get_tex_count_stats(input_files)

        # Handle prefill from input if enabled
        if self.agent_config.use_prefill_from_input:
            tool_state.first_k_tex_document = get_first_k_from_document(self.agent_config.input_file, self.agent_config.K)

        # Merge figure_file into figure_files if it exists
        if self.agent_config.figure_file and self.agent_config.figure_file not in tool_state.figure_files:
            tool_state.add_figure_files([self.agent_config.figure_file])
        if self.agent_config.figure_files:
            tool_state.add_figure_files(self.agent_config.figure_files)

        # Extract figures if configured
        if self.agent_config.auto_extract_figure:
            if extracted_figures := extract_figure_paths_from_latex(self.agent_config.input_file):
                tool_state.add_figure_files(extracted_figures)

        if self.agent_config.auto_extract_tikz_figure:
            for input_file in input_files:
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(input_file)
                if extracted_tikz_figures:
                    tool_state.add_figure_files(extracted_tikz_figures)

        # Initialize state and messages
        global_state = AgentGlobalState.initialize()
        messages = []

        # Process first round
        round_state, global_state, tool_state, end_turn, messages = self.process_first_round(
            messages, self.user_vars, global_state, tool_state, self.output_file[0]
        )

        # Handle output and logging
        self.handle_output(round_state, global_state, self.output_file[0], end_turn, round=0)
        logger.info(
            f"\n\nProcessed input file {self.agent_config.input_file} "
            f"and/or input files {self.agent_config.input_files}. "
            f"The round 0 output was saved as {self.output_file[1]}"
        )
        logger.info("Completed round 0")

        return round_state, global_state, messages, end_turn, tool_state

    def reflect(self, global_state: AgentGlobalState, messages, tool_state: ToolState, round: int = 1):
        if self.agent_config.output_files:
            # Handle multiple output files
            if self.agent_config.include_tex_count:
                tool_state.tex_count_stats = get_tex_count_stats(self.agent_config.output_files)

            if self.agent_config.auto_extract_tikz_figure_reflect:
                # Handle multiple output files
                for output_file in self.output_handler.output_files[round]:
                    logger.debug(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        tool_state.add_figure_files(extracted_tikz_figures)
        else:
            # Handle single output file
            logger.debug(f"Output files: {self.output_handler.output_files[0]}")
            generated_output_file = self.output_handler.output_files[0][0]
            if self.agent_config.include_tex_count:
                tool_state.tex_count_stats = get_tex_count_stats(generated_output_file)
            if self.agent_config.auto_extract_tikz_figure_reflect:
                logger.debug(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    tool_state.add_figure_files(extracted_tikz_figures)

        if self.agent_config.use_prefill_from_input:
            tool_state.first_k_tex_document = get_first_k_from_document(self.agent_config.input_file, self.agent_config.K)

        round_state, global_state, tool_state, end_turn, messages = self.process_reflection_round(
            messages,
            self.user_vars,
            global_state,
            tool_state,
            self.output_file[1],
        )

        self.handle_output(round_state, global_state, self.output_file[1], end_turn, round=1)

        logger.info(
            f"\n\nProcessed input file {self.agent_config.input_file} "
            f"and/or input files {self.agent_config.input_files}. "
            f"The round 1 output was saved as {self.output_file[1]}"
        )

        logger.info("Completed round 1")

        return round_state, global_state, messages, end_turn

    def run(self):
        round_state, global_state, messages, end_turn, tool_state = self.process()
        if self.agent_config.reflect and end_turn:
            # Create a new ToolState for reflection round
            reflection_tool_state = ToolState.initialize()
            reflection_round_state, global_state, reflection_messages, end_turn_reflection = self.reflect(
                global_state, messages, reflection_tool_state
            )
            messages = reflection_messages
