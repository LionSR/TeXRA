import os
import re
import time

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any

from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .figure_tools import extract_and_compile_tikzpictures_with_labels, extract_figure_paths_from_latex
from .file_utils import read_file, write_to_output_file, get_agent_dir_from_env
from .logdb_utils import logdb_start, logdb_output_files
from .model_config import MODEL_CONFIGS
from .openai_utils import best_connection_method
from .logging_utils import logger
from .prompt_utils import load_agent_settings_and_prompts, get_xml_format_from_files, render_prompt, get_list_of_files
from .replacement_utils import get_all_replacements, apply_replacements, get_replacements_by_category, apply_replacement_regex
from .state import State
from .tex_tools import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds, get_tex_count
from .output_utils import check_for_massive_repetition


class BaseReflectChainAgent(ABC):
    """
    Abstract base class for reflect chain agents.
    Provides a common structure for agents that involve reflection and processing.
    """

    def __init__(self, config: AgentConfig, agent_path: str):
        """Initialize with AgentConfig and agent path"""
        self.agent_config = config
        self.agent_path = agent_path or get_agent_dir_from_env()

        # Initialize basic attributes
        self.output_file = ["", ""]
        self.output_files = {0: [], 1: []}
        self.base_files = []

        # Load settings and prompts
        self.settings_dict, self.prompt_dict = load_agent_settings_and_prompts(self.agent_path, self.agent_config.agent)
        self.agent_settings = AgentSettings.from_dict(self.settings_dict)
        self.agent_prompts = AgentPrompts.from_dict(self.prompt_dict)
        # logger.debug(f"Agent settings: {self.agent_settings}")
        # logger.debug(f"Agent prompts: {self.agent_prompts}")

        self.setup()
        self.user_vars = self.get_user_vars()

    def get_user_vars(self):
        """Get the basic user variables that are common across all agents."""

        all_input_files = [self.agent_config.input_file] + self.agent_config.input_files
        all_reference_files = [self.agent_config.reference_file] + self.agent_config.reference_files
        all_auxiliary_files = [self.agent_config.auxiliary_file] + self.agent_config.auxiliary_files

        # Start with basic model and instruction vars
        user_vars = {
            "MODEL": self.agent_config.model,
            "MODEL_LIKES_TO_ASK_FOR_CONFIRMATION": self.model_config.likes_to_ask_for_confirmation,
            "INSTRUCTION": self.agent_config.instruction,
        }

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

        # Add variables for required files
        if self.agent_settings.required_files:
            # logger.debug(f"Required files: {self.agent_settings.required_files}")
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
            # logger.debug(f"Required files internal: {self.agent_settings.required_files_internal}")
            for var_name, file_name in self.agent_settings.required_files_internal.items():
                internal_file_path = os.path.join(self.agent_path, file_name)
                if os.path.exists(internal_file_path):
                    file_content = read_file(internal_file_path)
                    user_vars[f"{var_name}_FILE"] = internal_file_path
                    user_vars[f"{var_name}_CONTENT"] = file_content
                    logger.info(f"Found from [Required Files Internal] the [VAR '{var_name}']: {internal_file_path}")
                else:
                    logger.warning(f"[Internal required file] {internal_file_path} not found from [VAR '{var_name}']")

        # Handle pattern-based file mappings if defined in settings
        if self.agent_settings.file_patterns_contain:
            # logger.debug(f"File patterns contain: {self.agent_settings.file_patterns_contain}")
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
        if self.agent_config.output_files:
            self.base_files = self.agent_config.output_files
        else:
            self.base_files = [self.agent_config.input_file]

        # Set up logging
        logger.info(f"Processing file: {self.agent_config.input_file}")

        # Initialize model config
        if self.agent_config.model in MODEL_CONFIGS:
            self.model_config = MODEL_CONFIGS[self.agent_config.model]
        else:
            raise ValueError(f"Model {self.agent_config.model} not found in MODEL_CONFIGS")

        self.client = self.model_config.get_client()

        self.use_scratchpad = "<scratchpad>" in self.agent_settings.prefills if self.agent_settings.prefills else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)
        self.tex_count_stats = None
        self.first_k_tex_document = None

        # Initialize logging
        self.log_file = logdb_start(self.agent_config, self.agent_settings)

    @abstractmethod
    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        pass

    @abstractmethod
    def get_output_file(self, round: int = 0) -> str:
        pass

    def _handle_single_output(self, output_file: str) -> None:
        if ".tex" in self.agent_config.input_file and ".tex" in output_file:
            _ = run_latexdiff(self.agent_config.input_file, output_file, self.agent_config.agent)

    def _handle_multiple_outputs(self, output_files: List[str]) -> None:
        logger.debug(f"Handling multiple outputs: tasked output_files: {self.agent_config.output_files}; actual output_files: {output_files}")
        for input_file, output_file in zip(self.agent_config.output_files, output_files):
            logdb_output_files(output_file, self.log_file)
            if ".tex" in input_file and ".tex" in output_file:
                _ = run_latexdiff(input_file, output_file, self.agent_config.agent)

    def _get_tex_count_stats(self, input_files: str | List[str]) -> Optional[str]:
        if isinstance(input_files, str):
            input_files = [input_files]
        tex_count_stats = get_tex_count(input_files)
        return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n" if tex_count_stats else None

    def _get_first_k_from_document(self) -> Optional[str]:
        K = self.agent_config.K
        try:
            with open(self.agent_config.input_file, encoding="utf-8") as f:
                content = f.read()
                return content[:K].strip()  # Return only the first k characters, stripped
        except OSError as e:
            logger.error(f"Error reading file {self.agent_config.input_file}: {e}")
            return None

    def _handle_latexdiff(self, round: int) -> None:
        logger.info(f"Running latexdiff for {self.agent_config.agent} round {round}")

        logger.debug(f"Base files: {self.base_files}")
        logger.debug(f"Round {round} output files: {self.output_files[round]}")

        for base_file, output_file in zip(self.base_files, self.output_files[round]):
            run_latexdiff_for_round(base_file, output_file, self.agent_config.agent, round)

        for r in range(1, round + 1):
            for output_file1, output_file2 in zip(self.output_files[r - 1], self.output_files[r]):
                run_latexdiff_between_rounds(output_file1, output_file2, self.agent_config.agent)

    def _replace_input_commands(self, base_files: List[str], output_files: List[str]) -> None:
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(base_files, output_files)}

        for output_file in output_files:
            content = read_file(output_file)

            def replace_input(match):
                input_file = match.group(1)
                if input_file in base_to_output:
                    return f"\\input{{{base_to_output[input_file]}}}"
                return match.group(0)

            new_content = re.sub(r"\\input{([^}]+)}", replace_input, content)

            if new_content != content:
                with open(output_file, "w") as f:
                    f.write(new_content)
                logger.debug(f"Updated input commands in {output_file}")

    def _process_response_cycle(
        self,
        state: State,
        accumulated_output: str,
        messages: List[Dict[str, Any]],
        output_file: str,
    ):
        end_turn = False

        while not end_turn:
            file_exists = os.path.exists(output_file)
            start_time = time.time()
            response_object = self.model_config.create_response(
                client=self.client,
                messages=messages,
                temperature=self.agent_settings.temperature,
                # system_prompt=agent_prompts.system_prompt,
                system_prompt=render_prompt(self.agent_prompts.system_prompt, self.user_vars),
                end_tag=self.agent_settings.end_tag,
            )
            response_time = time.time() - start_time
            state.update_response_time(response_time)
            logger.info(f"Response time: {response_time:.2f}s")
            new_response, input_tokens, output_tokens, stop_reason = self.model_config.extract_response_statistics(
                response_object, self.agent_settings.end_tag
            )
            logger.info(f"Stop reason: {stop_reason}")
            logger.info(f"Token usage: {response_object.usage}")

            new_response = apply_replacement_regex(new_response, get_replacements_by_category("lazy"), flags=re.DOTALL | re.MULTILINE)
            new_response = apply_replacements(new_response, get_all_replacements())

            state.update_token_counts(
                input_tokens,
                output_tokens,
                getattr(response_object.usage, "cache_read_input_tokens", 0),
                getattr(response_object.usage, "cache_creation_input_tokens", 0),
            )

            best_connector, _ = best_connection_method(state.last_response[-self.agent_config.K :], new_response[: self.agent_config.K])

            massive_repetition_detected = check_for_massive_repetition(state.last_response, new_response)
            if not massive_repetition_detected:
                accumulated_output += best_connector + new_response
                file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)
                logger.debug(f"Last {self.agent_config.K} characters of the response: {new_response[-self.agent_config.K:]}")
                state.last_response = new_response

                # anthropic models with prefills, so we need to update the messages
                if messages[-1]["role"] == "assistant":
                    if self.model_config.supports_prompt_caching:
                        if isinstance(messages[-1]["content"], list):
                            if len(messages[-1]["content"]) >= 2 and isinstance(messages[-1]["content"][-2], dict):
                                if "cache_control" in messages[-1]["content"][-2]:
                                    messages[-1]["content"][-2].pop("cache_control")
                            messages[-1]["content"].append(
                                {"type": "text", "text": best_connector + new_response, "cache_control": {"type": "ephemeral"}}
                            )
                        else:
                            messages[-1]["content"] = [{"type": "text", "text": accumulated_output, "cache_control": {"type": "ephemeral"}}]
                    else:
                        messages[-1]["content"] = accumulated_output

            end_turn, should_stop = self.model_config.check_stop_conditions(
                stop_reason, new_response, state, self.agent_settings, massive_repetition_detected
            )
            if should_stop:
                self.model_config.print_stop_flags(end_turn, new_response, state, self.agent_settings, massive_repetition_detected)
                break

            state.increment_continuation()
            logger.info(f"Starting continuation #{state.continuation_count}")

            if self.model_config.is_openai_compatible:
                if stop_reason == "length" and not self.agent_settings.has_end_tag(new_response):
                    self.model_config.handle_continuation(messages, state, self.agent_settings, self.agent_config)
                    continue

            if self.model_config.likes_to_ask_for_confirmation:
                if stop_reason != "max_tokens" and stop_reason != "stop_sequence" and not self.agent_settings.has_end_tag(new_response):
                    end_turn = False
                    self.model_config.handle_continuation(messages, state, self.agent_settings, self.agent_config)
                    continue

        return state, accumulated_output, end_turn

    def process_first_round(
        self,
        output_file: str,
        user_vars: Dict[str, str],
        state: State,
        messages: List[Dict[str, Any]],
        figure_files: Optional[List[str]] = None,
        round: int = 0,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the first round."""
        logger.info(f"Processing round {round}")

        system_prompt = render_prompt(self.agent_prompts.system_prompt, user_vars)
        user_request = render_prompt(self.agent_prompts.user_request, user_vars)
        user_prefix = render_prompt(self.agent_prompts.user_prefix, user_vars)
        if tex_count_stats:
            user_prefix = f"{tex_count_stats}{user_prefix}"
        user_request = render_prompt(self.agent_prompts.user_request, user_vars)

        messages = self.model_config.initialize_messages(
            user_prefix,
            user_request,
            figure_files=self.agent_config.figure_files,
            system_prompt=system_prompt,
        )

        accumulated_output = None
        prefill = self.agent_settings.prefills[0] if self.agent_settings.prefills else ""

        accumulated_output = prefill
        accumulated_output, end_turn, messages = self.model_config.initialize_output_and_prefill(
            output_file,
            self.agent_config,
            self.agent_settings,
            messages,
            prefill,
            accumulated_output,
            first_k_tex_document,
        )

        if end_turn:
            return State.initialize(accumulated_output), accumulated_output, end_turn, messages

        state = State.initialize(accumulated_output)

        state, accumulated_output, end_turn = self._process_response_cycle(
            state,
            accumulated_output,
            messages,
            output_file,
        )

        logger.info(f"Completed round {round}")
        return state, accumulated_output, end_turn, messages

    def process_reflection_round(
        self,
        output_file: str,
        user_vars: Dict[str, str],
        state: State,
        messages: List[Dict[str, Any]],
        figure_files: Optional[List[str]] = None,
        round: int = 1,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the reflection round."""
        logger.info(f"Processing round {round}")

        user_request_reflect = render_prompt(self.agent_prompts.user_reflect, user_vars)
        user_message = f"{user_request_reflect}\n"
        if tex_count_stats:
            user_message = f"{tex_count_stats}{user_message}"

        messages = self.model_config.create_reflection_message(messages, user_message, figure_files)

        accumulated_output = None
        prefill = self.agent_settings.prefills[round] if len(self.agent_settings.prefills) > round else self.agent_settings.prefills[0]

        accumulated_output = prefill
        accumulated_output, end_turn, messages = self.model_config.initialize_output_and_prefill(
            output_file,
            self.agent_config,
            self.agent_settings,
            messages,
            prefill,
            accumulated_output,
            first_k_tex_document,
        )

        if end_turn:
            return State.initialize(accumulated_output), accumulated_output, end_turn, messages

        state.continuation_count = 0
        state.last_response = accumulated_output

        state, accumulated_output, end_turn = self._process_response_cycle(
            state,
            accumulated_output,
            messages,
            output_file,
        )

        logger.info(f"Completed round {round}")
        return state, accumulated_output, end_turn, messages

    def process(self):
        input_files = [self.agent_config.input_file] + (self.agent_config.input_files or [])
        if self.agent_config.include_tex_count:
            self.tex_count_stats = self._get_tex_count_stats(input_files)
        if self.agent_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        # Merge figure_file into figure_files if it exists
        if self.agent_config.figure_file:
            if not self.agent_config.figure_files:
                self.agent_config.figure_files = []
            if self.agent_config.figure_file not in self.agent_config.figure_files:
                self.agent_config.figure_files.append(self.agent_config.figure_file)

        # Extract figures if configured
        if self.agent_config.auto_extract_figure:
            extracted_figures = extract_figure_paths_from_latex(self.agent_config.input_file)
            if extracted_figures:
                self.agent_config.figure_files.extend(extracted_figures)

        if self.agent_config.auto_extract_tikz_figure:
            for input_file in [self.agent_config.input_file] + (self.agent_config.input_files or []):
                extracted_tikz = extract_and_compile_tikzpictures_with_labels(input_file)
                if extracted_tikz:
                    self.agent_config.figure_files.extend(extracted_tikz)

        # Initialize state and messages
        state = State.initialize()
        messages = []

        state, accumulated_output, end_turn, messages = self.process_first_round(
            self.output_file[0],
            self.user_vars,
            state,
            messages,
            figure_files=self.agent_config.figure_files,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file[0], round=0)

        logger.info(f"\n\nProcessed input files {get_list_of_files(input_files)}. The output was saved as {self.output_file[0]}")

        return state, messages, end_turn

    def reflect(self, state: State, messages, round: int = 1):
        reflection_figure_files = []
        if self.agent_config.output_files:
            # Handle multiple output files
            if self.agent_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(self.agent_config.output_files)

            if self.agent_config.auto_extract_tikz_figure_reflect:
                # Handle multiple output files
                for output_file in self.output_files[round]:
                    logger.debug(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        reflection_figure_files.extend(extracted_tikz_figures)
        else:
            # Handle single output file
            logger.debug(f"Output files: {self.output_files}")
            generated_output_file = self.output_files[0][0]
            if self.agent_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(generated_output_file)
            if self.agent_config.auto_extract_tikz_figure_reflect:
                logger.debug(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    reflection_figure_files.extend(extracted_tikz_figures)

        if self.agent_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = self.process_reflection_round(
            self.output_file[1],
            self.user_vars,
            state,
            messages,
            figure_files=reflection_figure_files,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )
        self.handle_output(state, end_turn, self.output_file[1], round=1)

        logger.info(
            f"\n\nProcessed input file {self.agent_config.input_file} "
            f"and/or input files {self.agent_config.input_files}. "
            f"The reflection output was saved as {self.output_file[1]}"
        )

        return state, messages, end_turn

    def run(self):
        state, messages, end_turn = self.process()
        if self.agent_config.reflect and end_turn:
            state, messages, end_turn = self.reflect(state, messages)
        return state, messages
