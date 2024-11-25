import os
import re
from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any
import time

from .logging_utils import logger
from .figure_tools import extract_and_compile_tikzpictures_with_labels
from .tex_tools import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds, get_tex_count
from .output_utils import (
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
    check_for_massive_repetition,
)
from .logdb_utils import logdb_start, logdb_and_print_statistics, logdb_output_files
from .prompt_utils import load_agent_settings_and_prompts, get_xml_format_from_files, render_prompt
from .file_utils import read_file, write_to_output_file, get_common_env
from .openai_utils import best_connection_method
from .replacement_utils import get_all_replacements, apply_replacements

from .state import State
from .model_config import MODEL_CONFIGS
from .config import TaskConfig, AgentSettings, AgentPrompts


def get_output_file_name(input_file: str, agent: str, model: str, output_ext: str, round: int, edited_file: Optional[str] = None) -> str:
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]

    if edited_file:
        # Extract the round number from the edited file
        edited_round = int(re.search(r"_r(\d+)_", edited_file).group(1))
        new_round = edited_round + round + 1
    else:
        new_round = round

    output_file = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{output_ext}"
    logger.debug(f"Output file: {output_file}")
    return output_file


class BaseReflectChainAgent(ABC):
    """
    Abstract base class for reflect chain agents.
    Provides a common structure for agents that involve reflection and processing.
    """

    def __init__(self, args, agent_path: str):
        """Initialize the agent with command line arguments and agent path."""
        self.args = args
        self.agent_path = agent_path

        # Initialize basic attributes
        self.output_file = ["", ""]
        self.output_files = {0: [], 1: []}
        self.base_files = []

        # These will be initialized in setup()
        self.settings_dict = None
        self.prompt_dict = None
        self.model_config = None
        self.agent_settings = None
        self.agent_prompts = None
        self.client = None
        self.log_file = None
        self.use_scratchpad = False
        self.tex_count_stats = None
        self.first_k_tex_document = None

        # Initialize configurations
        self.task_config = TaskConfig.from_args(args)

        self.setup()
        self.user_vars = self.get_user_vars()

    def get_user_vars(self):
        """Get the basic user variables that are common across all agents."""

        user_vars = {
            "INSTRUCTION": self.task_config.instruction,
            # input file
            "INPUT_FILE": self.task_config.input_file,
            "INPUT_CONTENT": read_file(self.task_config.input_file),
            "ADDITIONAL_INPUTS": get_xml_format_from_files(self.task_config.input_files),
            # reference files
            "REFERENCE_FILE": self.task_config.reference_file,
            "REFERENCE_CONTENT": read_file(self.task_config.reference_file),
            "ADDITIONAL_REFERENCES": get_xml_format_from_files(self.task_config.reference_files),
            # "ALL_REFERENCES": get_xml_format_from_files(self.task_config.reference_files),
            # auxiliary files
            "AUXILIARY_FILE": self.task_config.auxiliary_file,
            "AUXILIARY_CONTENT": read_file(self.task_config.auxiliary_file),
            "ADDITIONAL_AUXILIARIES": get_xml_format_from_files(self.task_config.auxiliary_file),
            # "ALL_AUXILIARY_FILES": get_xml_format_from_files(self.task_config.auxiliary_files),
            # edited file
            "EDITED_FILE": self.task_config.edited_file,
            "EDITED_CONTENT": read_file(self.task_config.edited_file),
        }

        # Add variables for required files
        if self.agent_settings.required_files:
            for var_name, file_path in self.agent_settings.required_files.items():
                file_content = read_file(file_path) if os.path.exists(file_path) else None
                user_vars[f"{var_name}_FILE"] = file_path
                user_vars[f"{var_name}_CONTENT"] = file_content

        # Add variables for internal required files (from prompt directory)
        if hasattr(self.agent_settings, "required_files_internal"):
            _, _, prompt_dir = get_common_env(self.task_config.model)
            # Get the agent-specific directory (e.g., 'agents/prl' for PRL agents)
            agent_dir = os.path.dirname(os.path.join(prompt_dir, self.task_config.agent))

            for var_name, file_name in self.agent_settings.required_files_internal.items():
                internal_file_path = os.path.join(agent_dir, file_name)
                if os.path.exists(internal_file_path):
                    file_content = read_file(internal_file_path)
                    user_vars[f"{var_name}_FILE"] = internal_file_path
                    user_vars[f"{var_name}_CONTENT"] = file_content
                else:
                    logger.warning(f"Internal required file not found: {internal_file_path}")

        # Handle pattern-based file mappings if defined in settings
        if hasattr(self.agent_settings, "file_patterns_contain"):
            for pattern_config in self.agent_settings.file_patterns_contain:
                pattern = pattern_config["pattern"].lower()
                var_name = pattern_config["var_name"]
                categories = pattern_config["categories"]

                # Search in specified categories
                for category in categories:
                    # Get the value from TaskConfig using dictionary-style access
                    category_value = self.task_config[category]

                    if category.endswith("_file"):  # Single file categories
                        if category_value and pattern in category_value.lower():
                            file_content = read_file(category_value)
                            if file_content and os.path.exists(category_value):
                                user_vars[var_name + "_FILE"] = category_value
                                user_vars[var_name + "_CONTENT"] = file_content
                            else:
                                logger.warning(f"File not found: {category_value}")

                    elif category.endswith("_files"):  # Multiple file categories
                        if category_value:
                            for file in category_value:
                                if pattern in file.lower():
                                    file_content = read_file(file)
                                    if file_content and os.path.exists(file):
                                        user_vars[var_name + "_FILE"] = file
                                        user_vars[var_name + "_CONTENT"] = file_content
                                    else:
                                        logger.warning(f"File not found: {file}")
                                    break  # Stop after first match

        # Handle output files order - use default_output_files if no output_files specified
        if self.task_config.output_files:
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.task_config.output_files)
        elif hasattr(self.agent_settings, "default_output_files"):
            # If no output_files specified but default_output_files exists in settings
            self.task_config.output_files = self.agent_settings.default_output_files
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.agent_settings.default_output_files)

        return user_vars

    def setup(self):
        """Set up the agent for processing."""
        # Initialize base files
        if self.task_config.output_files:
            self.base_files = self.task_config.output_files
        else:
            self.base_files = [self.task_config.input_file]

        # Set up logging
        logger.debug(f"Args: {self.args}")  # Keep this for debugging
        logger.info(f"Processing file: {self.task_config.input_file}")

        # Initialize model config
        if self.task_config.model in MODEL_CONFIGS:
            self.model_config = MODEL_CONFIGS[self.task_config.model]
        else:
            raise ValueError(f"Model {self.task_config.model} not found in MODEL_CONFIGS")

        self.client = self.model_config.get_client()

        # Load agent settings and prompts
        self.settings_dict, self.prompt_dict = load_agent_settings_and_prompts(self.agent_path, self.task_config.agent)
        self.agent_settings = AgentSettings.from_dict(self.settings_dict)
        self.agent_prompts = AgentPrompts.from_dict(self.prompt_dict)
        # logger.debug(f"Agent settings: {self.agent_settings}")
        # logger.debug(f"Agent prompts: {self.agent_prompts}")

        self.use_scratchpad = "<scratchpad>" in self.agent_settings.prefills if self.agent_settings.prefills else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)
        self.tex_count_stats = None
        self.first_k_tex_document = None

        # Initialize logging
        self.log_file = logdb_start(self.task_config, self.agent_settings)

    @abstractmethod
    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        pass

    @abstractmethod
    def get_output_file(self, round: int = 0) -> str:
        pass

    def _handle_single_output(self, output_file: str) -> None:
        if self.agent_settings.output_ext == "tex":
            run_latexdiff(self.task_config.input_file, output_file, self.task_config.agent)

    def _handle_multiple_outputs(self, output_files: List[str]) -> None:
        for input_file, output_file in zip(self.task_config.output_files, output_files):
            logdb_output_files(output_file, self.log_file)
            if self.agent_settings.output_ext == "tex":
                run_latexdiff(input_file, output_file, self.task_config.agent)

    def _get_tex_count_stats(self, input_files: str | List[str]) -> Optional[str]:
        if isinstance(input_files, str):
            input_files = [input_files]
        tex_count_stats = get_tex_count(input_files)
        return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n" if tex_count_stats else None

    def _get_first_k_from_document(self) -> Optional[str]:
        K = self.task_config.K
        try:
            with open(self.task_config.input_file, encoding="utf-8") as f:
                content = f.read()
                return content[:K].strip()  # Return only the first k characters, stripped
        except OSError as e:
            logger.error(f"Error reading file {self.task_config.input_file}: {e}")
            return None

    def _handle_latexdiff(self, round: int) -> None:
        logger.info(f"Running latexdiff for {self.task_config.agent} round {round}")

        logger.debug(f"Base files: {self.base_files}")
        logger.debug(f"Round {round} output files: {self.output_files[round]}")

        for base_file, output_file in zip(self.base_files, self.output_files[round]):
            run_latexdiff_for_round(base_file, output_file, self.task_config.agent, round)

        for r in range(1, round + 1):
            for output_file1, output_file2 in zip(self.output_files[r - 1], self.output_files[r]):
                run_latexdiff_between_rounds(output_file1, output_file2, self.task_config.agent)

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
        client: Any,
        state: State,
        accumulated_output: str,
        messages,
        output_file: str,
        model_config: Any,
        task_config: TaskConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
    ):
        end_turn = False

        while not end_turn:
            file_exists = os.path.exists(output_file)
            start_time = time.time()
            response_object = model_config.create_response(
                client=client,
                messages=messages,
                temperature=agent_settings.temperature,
                system_prompt=agent_prompts.system_prompt,
                end_tag=agent_settings.end_tag,
            )
            response_time = time.time() - start_time
            state.update_response_time(response_time)
            logger.info(f"Response time: {response_time:.2f}s")
            new_response, input_tokens, output_tokens, stop_reason = model_config.extract_response_statistics(response_object, agent_settings.end_tag)
            logger.info(f"Stop reason: {stop_reason}")
            logger.info(f"Token usage: {response_object.usage}")

            new_response = apply_replacements(new_response, get_all_replacements())

            state.update_token_counts(
                input_tokens,
                output_tokens,
                getattr(response_object.usage, "cache_read_input_tokens", 0),
                getattr(response_object.usage, "cache_creation_input_tokens", 0),
            )

            best_connector, _ = best_connection_method(state.last_response[-task_config.K :], new_response[: task_config.K])

            massive_repetition_detected = check_for_massive_repetition(state.last_response, new_response)
            if not massive_repetition_detected:
                accumulated_output += best_connector + new_response
                file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)
                logger.debug(f"Last {task_config.K} characters of the response: {new_response[-task_config.K:]}")
                state.last_response = new_response

                if messages[-1]["role"] == "assistant":
                    if model_config.supports_prompt_caching:
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

            end_turn, should_stop = model_config.check_stop_conditions(stop_reason, new_response, state, agent_settings, massive_repetition_detected)
            if should_stop:
                model_config.print_stop_flags(end_turn, new_response, state, agent_settings, massive_repetition_detected, task_config.K)
                break

            state.increment_continuation()
            logger.info(f"Starting continuation #{state.continuation_count}")

            if not end_turn and not model_config.has_end_tag(new_response, agent_settings.end_tag, agent_settings.document_tag):
                model_config.handle_continuation(messages, new_response, agent_settings.end_tag, task_config.K)
                continue

        return state, accumulated_output, end_turn

    def process_first_round(
        self,
        client: Any,
        output_file: str,
        user_vars: Dict[str, str],
        state: State,
        messages,
        model_config: Any,
        task_config: TaskConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        figure_inputs: Optional[List[str]] = None,
        round: int = 0,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the first round."""
        logger.info(f"Processing round {round}")

        user_request = render_prompt(agent_prompts.user_request, user_vars)
        user_prefix = render_prompt(agent_prompts.user_prefix, user_vars)
        if tex_count_stats:
            user_prefix = f"{tex_count_stats}{user_prefix}"
        user_request = render_prompt(agent_prompts.user_request, user_vars)

        messages = model_config.initialize_messages(
            agent_prompts.system_prompt,
            user_prefix,
            user_request,
            figure_inputs,
        )

        accumulated_output = None
        prefill = agent_settings.prefills[0] if agent_settings.prefills else ""

        accumulated_output = prefill
        accumulated_output, end_turn, messages = model_config.initialize_output_and_prefill(
            output_file,
            task_config,
            agent_settings,
            messages,
            prefill,
            accumulated_output,
            first_k_tex_document,
        )

        if end_turn:
            return State.initialize(accumulated_output), accumulated_output, end_turn, messages

        state = State.initialize(accumulated_output)

        state, accumulated_output, end_turn = self._process_response_cycle(
            client,
            state,
            accumulated_output,
            messages,
            output_file,
            model_config,
            task_config,
            agent_settings,
            agent_prompts,
        )

        logger.info(f"Completed round {round}")
        return state, accumulated_output, end_turn, messages

    def process_reflection_round(
        self,
        client: Any,
        output_file: str,
        user_vars: Dict[str, str],
        state: State,
        messages,
        model_config: Any,
        task_config: TaskConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        figure_inputs: Optional[List[str]] = None,
        round: int = 1,
        tex_count_stats: Optional[str] = None,
        first_k_tex_document: Optional[str] = None,
    ):
        """Process the reflection round."""
        logger.info(f"Processing round {round}")

        user_request_reflect = render_prompt(agent_prompts.user_reflect, user_vars)
        user_message = f"{user_request_reflect}\n"
        if tex_count_stats:
            user_message = f"{tex_count_stats}{user_message}"

        messages = model_config.create_reflection_message(messages, user_message, figure_inputs)

        accumulated_output = None
        prefill = agent_settings.prefills[round] if len(agent_settings.prefills) > round else agent_settings.prefills[0]

        accumulated_output = prefill
        accumulated_output, end_turn, messages = model_config.initialize_output_and_prefill(
            output_file,
            task_config,
            agent_settings,
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
            client,
            state,
            accumulated_output,
            messages,
            output_file,
            model_config,
            task_config,
            agent_settings,
            agent_prompts,
        )

        logger.info(f"Completed round {round}")
        return state, accumulated_output, end_turn, messages

    def process(self):
        input_files = [self.task_config.input_file] + (self.task_config.input_files or [])
        if self.task_config.include_tex_count:
            self.tex_count_stats = self._get_tex_count_stats(input_files)
        if self.task_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        # Initialize state and messages
        state = State.initialize()
        messages = []

        state, accumulated_output, end_turn, messages = self.process_first_round(
            self.client,
            self.output_file[0],
            self.user_vars,
            state,
            messages,
            self.model_config,
            self.task_config,
            self.agent_settings,
            self.agent_prompts,
            figure_inputs=self.task_config.figure_inputs,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file[0], round=0)

        logger.info(f"\n\nProcessed input files {', '.join(input_files)}. The output was saved as {self.output_file[0]}")

        return state, messages, end_turn

    def reflect(self, state: State, messages, round: int = 1):
        reflection_figure_inputs = []
        if self.task_config.output_files:
            # Handle multiple output files
            if self.task_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(self.task_config.output_files)
            if self.task_config.auto_extract_tikz_figure_reflect:
                # Handle multiple output files
                for output_file in self.output_files[round]:
                    logger.debug(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        reflection_figure_inputs.extend(extracted_tikz_figures)
        else:
            # Handle single output file
            logger.debug(f"Output files: {self.output_files}")
            generated_output_file = self.output_files[0][0]
            if self.task_config.include_tex_count:
                self.tex_count_stats = self._get_tex_count_stats(generated_output_file)
            if self.task_config.auto_extract_tikz_figure_reflect:
                logger.debug(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    reflection_figure_inputs.extend(extracted_tikz_figures)

        if self.task_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = self.process_reflection_round(
            self.client,
            self.output_file[1],
            self.user_vars,
            state,
            messages,
            self.model_config,
            self.task_config,
            self.agent_settings,
            self.agent_prompts,
            figure_inputs=reflection_figure_inputs,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )
        self.handle_output(state, end_turn, self.output_file[1], round=1)

        logger.info(
            f"\n\nProcessed input file {self.task_config.input_file} "
            f"and/or input files {self.task_config.input_files}. "
            f"The reflection output was saved as {self.output_file[1]}"
        )

        return state, messages, end_turn

    def run(self):
        state, messages, end_turn = self.process()
        if self.task_config.reflect and end_turn:
            state, messages, end_turn = self.reflect(state, messages)
        return state, messages


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path: str):
        super().__init__(args, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.task_config.output_name_override if self.task_config.output_name_override else self.task_config.input_file
        file_extension = self.agent_settings.output_ext
        if self.use_scratchpad:
            file_extension = "xml"
        else:
            file_extension = self.agent_settings.output_ext

        return get_output_file_name(
            base_output_file, self.task_config.agent, self.model_config.name, file_extension, round, self.task_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            ensure_correct_xml_structure(output_file, self.agent_settings.document_tag)

            if self.task_config.output_files:
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                self._handle_multiple_outputs(output_files)
                self.output_files[round] = output_files

                self._replace_input_commands(self.base_files, output_files)
            else:
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings.document_tag)

                self._handle_single_output(processed_output_file)
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        logdb_output_files(output_file, self.log_file, self.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_files[round]


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path: str):
        super().__init__(args, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        file_extension = self.agent_settings.output_ext
        base_output_file = self.task_config.output_name_override if self.task_config.output_name_override else self.task_config.input_file
        return get_output_file_name(
            base_output_file, self.task_config.agent, self.model_config.name, file_extension, round, self.task_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            if self.task_config.output_files:  # Multiple output files
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                self._handle_multiple_outputs(output_files)
                self.output_files[round] = output_files
                self.output_file[round] = output_files[0]  # Set the first file as the singular output

                self._replace_input_commands(self.base_files, output_files)
            else:  # Single output file
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                self._handle_single_output(processed_output_file)
                self.output_file[round] = processed_output_file
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        logdb_output_files(output_file, self.log_file, self.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)

        return self.output_files[round]
