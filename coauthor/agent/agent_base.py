import os
import re
import time

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any

from ..latex import get_tex_count, extract_and_compile_tikzpictures_with_labels, extract_figure_paths_from_latex, best_connection_method

from ..utils.replacement import get_all_replacements, apply_replacements, get_replacements_by_category, apply_replacement_regex
from ..utils.xml import get_xml_format_from_files
from ..utils.file import read_file, write_to_output_file
from ..utils.prompt import render_prompt, get_list_of_files
from ..utils.repetition import check_for_massive_repetition

from ..logger import logger

from .agent_state import AgentState
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts

from .logdb import logdb_start
from .output_handler import OutputHandler


class BaseReflectChainAgent(ABC):
    """
    Abstract base class for reflect chain agents.
    Provides a common structure for agents that involve reflection and processing.
    """

    def __init__(self, model_handler: Any, agent_config: AgentConfig, agent_settings: AgentSettings, agent_prompts: AgentPrompts, agent_path: str):
        """Initialize with model handler, agent config, settings/prompts, and agent path"""
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

    def get_user_vars(self):
        """Get the basic user variables that are common across all agents."""
        user_vars = self._get_basic_vars()
        user_vars.update(self._get_file_vars())
        user_vars.update(self._get_required_file_vars())
        user_vars.update(self._get_pattern_based_file_vars())
        user_vars.update(self._get_output_files_order())
        return user_vars

    def _get_basic_vars(self) -> Dict[str, Any]:
        """Get basic model and instruction variables."""
        return {
            "MODEL": self.agent_config.model,
            "MODEL_LIKES_TO_ASK_FOR_CONFIRMATION": self.model_handler.capabilities.likes_to_ask_for_confirmation,
            "INSTRUCTION": self.agent_config.instruction,
        }

    def _get_file_vars(self) -> Dict[str, Any]:
        """Get variables related to input, reference, and auxiliary files."""
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

    def _get_required_file_vars(self) -> Dict[str, Any]:
        """Get variables from required files specified in agent settings."""
        user_vars = {}

        # Add variables for required files
        if self.agent_settings.required_files:
            for var_name, file_path in self.agent_settings.required_files.items():
                if os.path.exists(file_path):
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
                if os.path.exists(full_path):
                    file_content = read_file(full_path)
                    user_vars[f"{var_name}_FILE"] = full_path
                    user_vars[f"{var_name}_CONTENT"] = file_content
                    logger.info(f"Found from [Required Files Internal] the [VAR '{var_name}']: {full_path}")
                else:
                    logger.warning(f"[Required file internal] {full_path} not found from [VAR '{var_name}']")

        return user_vars

    def _get_pattern_based_file_vars(self) -> Dict[str, Any]:
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
                            file_content = read_file(category_value)
                            if file_content and os.path.exists(category_value):
                                user_vars[var_name + "_FILE"] = category_value
                                user_vars[var_name + "_CONTENT"] = file_content
                                logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{var_name}']: {category_value}")
                            else:
                                logger.warning(f"File {category_value} not found from [Pattern '{pattern}']")

                    elif category.endswith("_files"):  # Multiple file categories
                        if category_value:
                            for file in category_value:
                                if pattern in file.lower():
                                    file_content = read_file(file)
                                    if file_content and os.path.exists(file):
                                        user_vars[var_name + "_FILE"] = file
                                        user_vars[var_name + "_CONTENT"] = file_content
                                        logger.info(f"Found from [Pattern '{pattern}'] the [VAR '{var_name}']: {file}")
                                    else:
                                        logger.warning(f"File {file} not found from [Pattern '{pattern}']")
                                    break  # Stop after first match

        return user_vars

    def _get_output_files_order(self) -> Dict[str, Any]:
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

    def setup(self):
        """Set up the agent for processing."""
        # Initialize base files
        self.base_files = self.agent_config.output_files or [self.agent_config.input_file]

        # Set up logging
        logger.info(f"Processing file: {self.agent_config.input_file}")

        self.client = self.model_handler.get_client()

        self.use_scratchpad = "<scratchpad>" in self.agent_settings.prefills if self.agent_settings.prefills else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)
        self.tex_count_stats = None
        self.first_k_tex_document = None

        # Initialize logging
        self.log_id = logdb_start(self.agent_config, self.agent_settings)

    @abstractmethod
    def handle_output(self, state: AgentState, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        pass

    @abstractmethod
    def get_output_file(self, round: int) -> str:
        pass

    def _get_tex_count_stats(self, input_files: str | List[str]) -> Optional[str]:
        if isinstance(input_files, str):
            input_files = [input_files]
        tex_count_stats = get_tex_count(input_files)
        return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n" if tex_count_stats else None

    def _get_first_k_from_document(self) -> Optional[str]:
        K = self.agent_config.K
        content = read_file(self.agent_config.input_file)
        return content[:K].strip()  # Return only the first k characters, stripped

    def _process_response_cycle(
        self,
        state: AgentState,
        accumulated_output: str,
        messages: List[Dict[str, Any]],
        output_file: str,
    ):
        end_turn = False

        while not end_turn:
            file_exists = os.path.exists(output_file)
            start_time = time.time()
            response_object = self.model_handler.create_response(
                client=self.client,
                messages=messages,
                temperature=self.agent_settings.temperature or 0.0,
                system_prompt=render_prompt(self.agent_prompts.system_prompt, self.user_vars),
                end_tag=self.agent_settings.end_tag,
            )
            response_time = time.time() - start_time
            state.update_response_time(response_time)
            logger.info(f"Response time: {response_time:.2f}s")

            new_response, response_usage, stop_reason = self.model_handler.extract_response(response_object, self.agent_settings.end_tag)
            logger.info(f"Stop reason: {stop_reason}")
            logger.info(f"Token usage: {response_object.usage}")

            state.update_token_counts(response_usage)

            massive_repetition_detected = check_for_massive_repetition(state.last_response, new_response)
            if massive_repetition_detected:
                logger.error(f"The new response is: {new_response}")
                logger.error("Massive repetition detected - skipping this response")
                break

            if self.model_handler.capabilities.likes_to_ask_for_confirmation:
                new_response = apply_replacement_regex(new_response, get_replacements_by_category("lazy"), flags=re.DOTALL | re.MULTILINE)
            new_response = apply_replacements(new_response, get_all_replacements())

            logger.info("First K characters of the response:")
            logger.debug(f"{new_response[:self.agent_config.K]}")

            best_connector, _ = best_connection_method(state.last_response[-self.agent_config.K :], new_response[: self.agent_config.K])
            accumulated_output += best_connector + new_response

            file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)

            logger.info("Last K characters of the response:")
            logger.debug(f"{new_response[-self.agent_config.K:]}")

            state.last_response = new_response

            self.model_handler.update_message_content(messages, best_connector, new_response, accumulated_output)

            end_turn, should_stop = self.model_handler.check_stop_conditions(stop_reason, new_response, state, self.agent_settings)
            if should_stop:
                self.model_handler.print_stop_flags(end_turn, new_response, state, self.agent_settings)
                break

            state.increment_continuation()
            logger.info(f"Starting continuation #{state.continuation_count}")

            # TODO: maybe I can get rid of the conditioning and just use model_handler.handle_continuation
            if self.model_handler.is_openai_compatible:
                if stop_reason == "length" and not self.agent_settings.has_end_tag(new_response):
                    self.model_handler.handle_continuation(messages, state, self.agent_settings, self.agent_config)
                    continue

            if self.model_handler.is_anthropic and self.model_handler.likes_to_ask_for_confirmation:
                if stop_reason != "max_tokens" and stop_reason != "stop_sequence" and not self.agent_settings.has_end_tag(new_response):
                    end_turn = False
                    # this is handle confirmation actually
                    self.model_handler.handle_continuation(messages, state, self.agent_settings, self.agent_config)
                    continue

        return state, accumulated_output, end_turn

    def process_first_round(
        self,
        output_file: str,
        user_vars: Dict[str, str],
        state: AgentState,
        messages: List[Dict[str, Any]],
        round: int = 0,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the first round."""
        logger.info(f"\n\nProcessing round {round}")

        system_prompt = render_prompt(self.agent_prompts.system_prompt, user_vars)
        user_request = render_prompt(self.agent_prompts.user_request, user_vars)
        user_prefix = render_prompt(self.agent_prompts.user_prefix, user_vars)

        # TODO: Consider making tex_count_stats and first_k_tex_document part of a agent tool state object
        if tex_count_stats:
            user_prefix = f"{tex_count_stats}{user_prefix}"
        user_request = render_prompt(self.agent_prompts.user_request, user_vars)

        messages = self.model_handler.initialize_messages(
            user_prefix,
            user_request,
            figure_files=self.figure_files,
            system_prompt=system_prompt,
        )

        prefill = self.agent_settings.prefills[round] if round < len(self.agent_settings.prefills) else self.agent_settings.prefills[0]
        accumulated_output = prefill if prefill else ""

        accumulated_output, end_turn, messages = self.model_handler.initialize_output_and_prefill(
            output_file,
            self.agent_config,
            self.agent_settings,
            messages,
            prefill,
            accumulated_output,
            first_k_tex_document,
        )

        if end_turn:
            return AgentState.initialize(accumulated_output), accumulated_output, end_turn, messages

        state = AgentState.initialize(accumulated_output)
        # accumulated_output should perhaps be separate from state

        state, accumulated_output, end_turn = self._process_response_cycle(
            state,
            accumulated_output,
            messages,
            output_file,
        )

        return state, accumulated_output, end_turn, messages

    def process_reflection_round(
        self,
        output_file: str,
        user_vars: Dict[str, str],
        state: AgentState,
        messages: List[Dict[str, Any]],
        round: int = 1,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the reflection round."""
        logger.info(f"\n\nProcessing round {round}")

        user_request_reflect = render_prompt(self.agent_prompts.user_reflect, user_vars)
        user_message = f"{user_request_reflect}\n"
        if tex_count_stats:
            user_message = f"{tex_count_stats}{user_message}"

        messages = self.model_handler.create_reflection_message(messages, user_message, self.reflection_figure_files)

        prefill = self.agent_settings.prefills[round] if round < len(self.agent_settings.prefills) else self.agent_settings.prefills[0]
        accumulated_output = prefill if prefill else ""

        accumulated_output, end_turn, messages = self.model_handler.initialize_output_and_prefill(
            output_file,
            self.agent_config,
            self.agent_settings,
            messages,
            prefill,
            accumulated_output,
            first_k_tex_document,
        )

        if end_turn:
            return AgentState.initialize(accumulated_output), accumulated_output, end_turn, messages

        state.continuation_count = 0
        state.last_response = accumulated_output

        state, accumulated_output, end_turn = self._process_response_cycle(
            state,
            accumulated_output,
            messages,
            output_file,
        )

        return state, accumulated_output, end_turn, messages

    def process(self):
        input_files = [self.agent_config.input_file] + (self.agent_config.input_files or [])
        if self.agent_config.include_tex_count:
            self.tex_count_stats = self._get_tex_count_stats(input_files)
        if self.agent_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        # Merge figure_file into figure_files if it exists
        self.figure_files = self.agent_config.figure_files.copy() if self.agent_config.figure_files else []
        if self.agent_config.figure_file:
            if self.agent_config.figure_file not in self.figure_files:
                self.figure_files.append(self.agent_config.figure_file)

        # Extract figures if configured
        if self.agent_config.auto_extract_figure:
            extracted_figures = extract_figure_paths_from_latex(self.agent_config.input_file)
            if extracted_figures:
                self.figure_files.extend(extracted_figures)

        if self.agent_config.auto_extract_tikz_figure:
            for input_file in [self.agent_config.input_file] + (self.agent_config.input_files or []):
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(input_file)
                if extracted_tikz_figures:
                    self.figure_files.extend(extracted_tikz_figures)

        # Initialize state and messages
        state = AgentState.initialize()
        messages = []

        state, accumulated_output, end_turn, messages = self.process_first_round(
            self.output_file[0],
            self.user_vars,
            state,
            messages,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file[0], round=0)

        logger.info(
            f"\n\nProcessed input file {self.agent_config.input_file} "
            f"and/or input files {self.agent_config.input_files}. "
            f"The round 0 output was saved as {self.output_file[1]}"
        )

        logger.info("Completed round 0")

        return state, messages, end_turn

    def reflect(self, state: AgentState, messages, round: int = 1):
        self.reflection_figure_files = []
        if self.agent_config.output_files:
            # Handle multiple output files
            if self.agent_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(self.agent_config.output_files)

            if self.agent_config.auto_extract_tikz_figure_reflect:
                # Handle multiple output files
                for output_file in self.output_handler.output_files[round]:
                    logger.debug(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        self.reflection_figure_files.extend(extracted_tikz_figures)
        else:
            # Handle single output file
            logger.debug(f"Output files: {self.output_handler.output_files[0]}")
            generated_output_file = self.output_handler.output_files[0][0]
            if self.agent_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(generated_output_file)
            if self.agent_config.auto_extract_tikz_figure_reflect:
                logger.debug(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    self.reflection_figure_files.extend(extracted_tikz_figures)

        if self.agent_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = self.process_reflection_round(
            self.output_file[1],
            self.user_vars,
            state,
            messages,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )
        self.handle_output(state, end_turn, self.output_file[1], round=1)

        logger.info(
            f"\n\nProcessed input file {self.agent_config.input_file} "
            f"and/or input files {self.agent_config.input_files}. "
            f"The round 1 output was saved as {self.output_file[1]}"
        )

        logger.info("Completed round 1")

        return state, messages, end_turn

    def run(self):
        state, messages, end_turn = self.process()
        if self.agent_config.reflect and end_turn:
            state, messages, end_turn = self.reflect(state, messages)
        return state, messages
