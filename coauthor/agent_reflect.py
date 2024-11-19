import os
import re
from abc import ABC, abstractmethod
from typing import Optional, List

from .logging_utils import logger
from .figure_tools import extract_and_compile_tikzpictures_with_labels
from .process import process_first_round, process_reflection_round
from .tex_tools import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds, get_tex_count
from .output_utils import (
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
)
from .logdb_utils import log_db_start, log_db_and_print_statistics, log_db_output_files
from .prompt_utils import load_agent_settings_and_prompts, get_xml_format_from_files
from .model_config import MODEL_CONFIGS
from .file_utils import read_file
from .state import State
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
        self.edited_file = self.task_config.edited_file

        self.setup()
        self.user_vars = self.get_user_vars()

    def get_user_vars(self):
        """Get the basic user variables that are common across all agents."""
        args = self.args

        user_vars = {
            "INSTRUCTION": args.instruction if args.instruction else None,
            "INPUT_FILE": args.input_file,
            "INPUT_CONTENT": read_file(args.input_file),
            "SAMPLE_FILE": args.sample_files[0] if args.sample_files else None,
            "SAMPLE_CONTENT": read_file(args.sample_files[0]) if args.sample_files else None,
            "SAMPLES": get_xml_format_from_files(args.sample_files),
            "ADDITIONAL_INPUTS": get_xml_format_from_files(args.input_files),
            "AUXILIARY_FILES": get_xml_format_from_files(args.auxiliary_files),
        }

        # Add variables for required files
        if self.agent_settings.required_files:
            for var_name, file_path in self.agent_settings.required_files.items():
                file_content = read_file(file_path) if os.path.exists(file_path) else None
                user_vars[f"{var_name}_FILE"] = file_path
                user_vars[f"{var_name}_CONTENT"] = file_content

        if args.output_files:
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(args.output_files)

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
        self.log_file = log_db_start(self.task_config)

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
            log_db_output_files(output_file, self.log_file)
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

    def process(self):
        input_files = [self.task_config.input_file] + (self.task_config.input_files or [])
        if self.task_config.include_tex_count:
            self.tex_count_stats = self._get_tex_count_stats(input_files)
        if self.task_config.use_prefill_from_input:
            self.first_k_tex_document = self._get_first_k_from_document()

        # Initialize state and messages
        state = State.initialize()
        messages = []

        state, accumulated_output, end_turn, messages = process_first_round(
            self.client,
            self.output_file[0],
            self.user_vars,
            state,
            messages,
            model_config=self.model_config,
            task_config=self.task_config,
            agent_settings=self.agent_settings,
            agent_prompts=self.agent_prompts,
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

        if self.task_config.auto_extract_figure:
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = process_reflection_round(
            self.client,
            self.output_file[1],
            self.user_vars,
            state,
            messages,
            model_config=self.model_config,
            task_config=self.task_config,
            agent_settings=self.agent_settings,
            agent_prompts=self.agent_prompts,
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

        log_db_output_files(output_file, self.log_file, self.output_files[round])
        log_db_and_print_statistics(state, self.model_config, self.log_file)
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

        log_db_output_files(output_file, self.log_file, self.output_files[round])
        log_db_and_print_statistics(state, self.model_config, self.log_file)

        return self.output_files[round]
