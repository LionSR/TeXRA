import os
import re
from termcolor import colored, cprint
from abc import ABC, abstractmethod
from typing import Optional, List

from .figure_tools import extract_and_compile_tikzpictures_with_labels
from .process import process_first_round, process_reflection_round
from .tex_tools import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds, get_tex_count
from .output_utils import (
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
)
from .log_utils import log_start, log_end, log_and_print_statistics, log_output_files
from .prompt_utils import load_agent_settings_and_prompts, get_xml_format_from_files
from .settings_utils import get_output_settings, get_prompt_settings
from .model_config import MODEL_CONFIGS, ModelConfig
from .file_utils import read_file
from .state import State


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
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def get_user_vars_basic(args):
    user_vars = {
        "INSTRUCTION": args.instruction if args.instruction else None,
        "INPUT_FILE": args.input_file,
        "INPUT_CONTENT": read_file(args.input_file),
        "SAMPLE_FILE": args.sample_files[0] if args.sample_files else None,
        "SAMPLE_CONTENT": read_file(args.sample_files[0]) if args.sample_files else None,
        "ADDITIONAL_INPUTS": get_xml_format_from_files(args.input_files),
        "AUXILIARY_FILES": get_xml_format_from_files(args.auxiliary_files),
    }
    return user_vars


def update_user_vars_multiple_output(args, user_vars):
    all_input_files = [args.input_file] + (args.input_files or [])
    if not args.output_files:
        raise ValueError("Output files are required for multiple output agents.")
    if len(args.output_files) > len(all_input_files):
        raise ValueError("Number of output files must not be greater than the number of input files.")

    user_vars["OUTPUT_FILES_ORDER"] = ", ".join(args.output_files)


class BaseReflectChainAgent(ABC):
    """
    Abstract base class for reflect chain agents.
    Provides a common structure for agents that involve reflection and processing.
    """

    def __init__(self, args, agent_path: str):
        self.args = args
        self.agent_path = agent_path
        self.agent_settings = None
        self.prompt_dict = None
        self.user_vars = None
        self.model_config: Optional[ModelConfig] = None
        self.output_settings = None
        self.prompt_settings = None
        self.client = None
        self.log_file = None
        self.output_file = {0: None, 1: None}
        self.output_files: dict[int, List[str]] = {0: [], 1: []}
        if self.args.output_files:
            self.base_files = self.args.output_files
        else:
            self.base_files = [self.args.input_file]
        self.edited_file = args.edited_file if hasattr(args, "edited_file") else None

    def setup(self):
        print(f"{colored('args:', 'blue')} {self.args}")
        print(colored(f"Processing {self.args.input_file}...\n", "green"))

        self.agent_settings, self.prompt_dict = load_agent_settings_and_prompts(self.agent_path, self.args.agent)
        self.user_vars = self.get_user_vars()

        # Get model config instead of settings
        model_name = self.args.model
        self.model_config = MODEL_CONFIGS[model_name]
        self.output_settings = get_output_settings(self.args, self.agent_settings)
        self.prompt_settings = get_prompt_settings(self.args, self.agent_path, self.prompt_dict)

        self.client = self.model_config.get_client()
        self.log_file = log_start(self.args)

        self.use_scratchpad = "<scratchpad>" in self.output_settings["prefills"][0] if self.output_settings["prefills"] else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)
        self.tex_count_stats = None
        self.first_k_tex_document = None

    @abstractmethod
    def get_user_vars(self):
        pass

    @abstractmethod
    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        pass

    @abstractmethod
    def get_output_file(self, round: int = 0) -> str:
        pass

    def _handle_single_output(self, output_file: str) -> None:
        if self.output_settings["output_ext"] == "tex":
            run_latexdiff(self.args.input_file, output_file, self.args.agent)

    def _handle_multiple_outputs(self, output_files: List[str]) -> None:
        for input_file, output_file in zip(self.args.output_files, output_files):
            log_output_files(output_file, self.log_file)
            if self.output_settings["output_ext"] == "tex":
                run_latexdiff(input_file, output_file, self.args.agent)

    def _get_tex_count_stats(self, input_files: str | List[str]) -> Optional[str]:
        if isinstance(input_files, str):
            input_files = [input_files]
        tex_count_stats = get_tex_count(input_files)
        return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n" if tex_count_stats else None

    def _get_first_k_from_document(self) -> Optional[str]:
        k = self.output_settings.get("k", 1000)
        try:
            with open(self.args.input_file, encoding="utf-8") as f:
                content = f.read()
                return content[:k].strip()  # Return only the first k characters, stripped
        except OSError as e:
            print(f"Error reading file {self.args.input_file}: {e}")
            return None

    def _handle_latexdiff(self, round: int) -> None:
        cprint(f"Handling latexdiff for {self.args.agent} in round {round}", "blue", "on_white")

        print(f"base_files: {self.base_files}")
        print(f"#{round} output_files : {self.output_files[round]}")

        for base_file, output_file in zip(self.base_files, self.output_files[round]):
            run_latexdiff_for_round(base_file, output_file, self.args.agent, round)

        for r in range(1, round + 1):
            for output_file1, output_file2 in zip(self.output_files[r - 1], self.output_files[r]):
                run_latexdiff_between_rounds(output_file1, output_file2, self.args.agent)

    def _replace_input_commands(self, base_files: List[str], output_files: List[str]) -> None:
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(base_files, output_files)}

        for output_file in output_files:
            with open(output_file) as f:
                content = f.read()

            def replace_input(match):
                input_file = match.group(1)
                if input_file in base_to_output:
                    return f"\\input{{{base_to_output[input_file]}}}"
                return match.group(0)

            new_content = re.sub(r"\\input{([^}]+)}", replace_input, content)

            if new_content != content:
                with open(output_file, "w") as f:
                    f.write(new_content)
                print(f"Updated input commands in {output_file}")

    def process(self):
        input_files = [self.args.input_file] + (self.args.input_files or [])
        if self.prompt_settings.get("include_tex_count"):
            self.tex_count_stats = self._get_tex_count_stats(input_files)
        if self.prompt_settings.get("use_prefill_from_input"):
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = process_first_round(
            self.client,
            self.output_file[0],
            self.user_vars,
            model_config=self.model_config,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=self.args.figure_inputs,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file[0], round=0)

        print(
            f"\n\nProcessed input files {colored(', '.join(input_files), 'green')}. "
            f"The output was saved as {colored(self.output_file[0], 'green')}"
        )

        return state, messages, end_turn

    def reflect(self, state: State, messages, round: int = 1):
        reflection_figure_inputs = []
        if self.args.output_files:
            if self.prompt_settings.get("include_tex_count"):
                self.tex_count_stats = self._get_tex_count_stats(self.args.output_files)
            if self.prompt_settings.get("include_tikz_reflection"):
                # Handle multiple output files
                for output_file in self.output_files[round]:
                    print(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        reflection_figure_inputs.extend(extracted_tikz_figures)
        else:
            generated_output_file = self.output_files[0][0]
            if self.prompt_settings.get("include_tex_count"):
                self.tex_count_stats = self._get_tex_count_stats(generated_output_file)
            if self.prompt_settings.get("include_tikz_reflection"):
                print(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    reflection_figure_inputs.extend(extracted_tikz_figures)

        if self.prompt_settings.get("use_prefill_from_input"):
            self.first_k_tex_document = self._get_first_k_from_document()

        state, accumulated_output, end_turn, messages = process_reflection_round(
            self.client,
            self.output_file[1],
            state,
            messages,
            model_config=self.model_config,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=reflection_figure_inputs,
            tex_count_stats=self.tex_count_stats,
            first_k_tex_document=self.first_k_tex_document,
        )
        self.handle_output(state, end_turn, self.output_file[1], round=1)

        print(
            f"\n\nProcessed input file {colored(self.args.input_file, 'green')} "
            f"and/or input files {colored(self.args.input_files, 'green')}. "
            f"The reflection output was saved as {colored(self.output_file[1], 'green')}"
        )

        return state, messages, end_turn

    def run(self):
        self.setup()
        state, messages, end_turn = self.process()
        if self.args.reflect and end_turn:
            state, messages, end_turn = self.reflect(state, messages)
        log_end(self.log_file)
        return state, messages


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path: str):
        super().__init__(args, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        if self.use_scratchpad:
            file_extension = "xml"
        else:
            file_extension = self.output_settings["output_ext"]

        return get_output_file_name(base_output_file, self.args.agent, self.model_config.name, file_extension, round, self.edited_file)

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        if end_turn:
            ensure_correct_xml_structure(output_file, self.agent_settings["document_tag"])

            if self.args.output_files:
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_multiple_outputs(output_files)
                self.output_files[round] = output_files

                self._replace_input_commands(self.base_files, output_files)
            else:
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])

                self._handle_single_output(processed_output_file)
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        log_output_files(output_file, self.log_file)
        log_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_files[round]


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path: str):
        super().__init__(args, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = self.output_settings["output_ext"]
        return get_output_file_name(base_output_file, self.args.agent, self.model_config.name, file_extension, round, self.edited_file)

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        if end_turn:
            if self.args.output_files:  # Multiple output files
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_multiple_outputs(output_files)
                self.output_files[round] = output_files
                self.output_file[round] = output_files[0]  # Set the first file as the singular output

                self._replace_input_commands(self.base_files, output_files)
            else:  # Single output file
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_single_output(processed_output_file)
                self.output_file[round] = processed_output_file
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        log_output_files(output_file, self.log_file)
        log_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_files[round]
