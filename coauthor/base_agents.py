import os
from abc import ABC, abstractmethod
from termcolor import colored
from .figure_tools import extract_and_compile_tikzpictures_with_labels
from .process import process_first_round, process_reflection_round
from .model_utils import get_model_client
from .tex_tools import run_latexdiff, get_tex_count
from .output_utils import (
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
)
from .log_utils import log_start, log_end, log_and_print_statistics, log_output_files
from .prompt_utils import load_agent_settings_and_prompts
from .settings_utils import get_model_settings, get_output_settings, get_prompt_settings


def get_output_file_name(input_file, agent, model, output_type, round):
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]
    output_type = output_type.strip(".")
    output_file = f"{file_name}_{agent_first_name_chunk}_r{round}_{model}.{output_type}"
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


class BaseReflectChainAgent(ABC):
    """
    Abstract base class for reflect chain agents.
    Provides a common structure for agents that involve reflection and processing.
    """

    def __init__(self, args, agent_path):
        self.args = args
        self.agent_path = agent_path
        self.agent_settings = None
        self.prompt_dict = None
        self.user_vars = None
        self.model_settings = None
        self.output_settings = None
        self.prompt_settings = None
        self.client = None
        self.log_file = None
        self.output_file = None
        self.reflect_output_file = None

    def setup(self):
        print(f"{colored('args:', 'blue')} {self.args}")
        print(colored(f"Processing {self.args.input_file}...\n", "green"))

        self.agent_settings, self.prompt_dict = load_agent_settings_and_prompts(self.agent_path, self.args.agent)
        self.user_vars = self.get_user_vars()
        self.model_settings = get_model_settings(self.args)
        self.output_settings = get_output_settings(self.args, self.agent_settings)
        self.prompt_settings = get_prompt_settings(self.args, self.agent_path, self.prompt_dict)
        self.client = get_model_client(self.model_settings["model"])
        self.log_file = log_start(self.args)
        self.use_scratchpad = "<scratchpad>" in self.output_settings["prefill_first"]
        self.output_file = self.get_output_file(round=0)
        self.reflect_output_file = self.get_output_file(round=1)

    @abstractmethod
    def get_user_vars(self):
        pass

    @abstractmethod
    def handle_output(self, state, end_turn, output_file, is_reflection_complete=False):
        pass

    @abstractmethod
    def get_output_file(self, round=0):
        pass

    def _handle_single_output(self, output_file):
        if self.output_settings["output_type"] == "tex":
            run_latexdiff(self.args.input_file, output_file, self.args.agent)

    def _handle_multiple_outputs(self, output_files):
        for input_file, output_file in zip(self.args.output_files, output_files):
            log_output_files(output_file, self.log_file)
            if self.output_settings["output_type"] == "tex":
                run_latexdiff(input_file, output_file, self.args.agent)

    @abstractmethod
    def _handle_reflection_diff(self, end_turn):
        pass

    def _get_tex_count_stats(self, input_files):
        if self.prompt_settings.get("include_tex_count"):
            if isinstance(input_files, str):
                input_files = [input_files]
            tex_count_stats = get_tex_count(input_files)
            if tex_count_stats:
                return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n"
        return ""

    def _get_first_k_tex_document(self):
        k = self.output_settings.get("k", 1000)
        if self.output_settings["output_type"] == "tex" and self.prompt_settings["use_prefill_from_input"]:
            try:
                with open(self.args.input_file, "r", encoding="utf-8") as f:
                    content = f.read()
                    return content[:k].strip()  # Return only the first k characters, stripped
            except IOError as e:
                print(f"Error reading file {self.args.input_file}: {e}")
        return None

    def process(self):
        input_files = [self.args.input_file] + (self.args.input_files or [])
        tex_count_stats = self._get_tex_count_stats(input_files)
        first_k_tex_document = self._get_first_k_tex_document()
        state, accumulated_output, end_turn, messages = process_first_round(
            self.client,
            self.output_file,
            self.user_vars,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=self.args.figure_inputs,
            tex_count_stats=tex_count_stats,
            first_k_tex_document=first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file, is_reflection_complete=False)

        print(f"\n\nProcessed input files {colored(', '.join(input_files), 'green')}. The output was saved as {colored(self.output_file, 'green')}")

        return state, messages

    def reflect(self, state, messages):
        reflection_figure_inputs = []

        if self.prompt_settings.get("include_tikz_reflection"):
            if self.args.output_files:
                # Handle multiple output files
                for output_file in self.args.output_files:
                    print(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        reflection_figure_inputs.extend(extracted_tikz_figures)
            else:
                # Handle single output file
                generated_output_file = get_output_file_name(
                    self.args.input_file, self.args.agent, self.model_settings["model"], self.output_settings["output_type"], round=0
                )
                print(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    reflection_figure_inputs.extend(extracted_tikz_figures)

        tex_count_stats = self._get_tex_count_stats(self.args.input_file)
        first_k_tex_document = self._get_first_k_tex_document()
        state, accumulated_output, end_turn, messages = process_reflection_round(
            self.client,
            self.reflect_output_file,
            state,
            messages,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=reflection_figure_inputs,
            tex_count_stats=tex_count_stats,
            first_k_tex_document=first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.reflect_output_file, is_reflection_complete=True)

        print(
            f"\n\nProcessed input file {colored(self.args.input_file, 'green')} and/or additional input files {colored(self.args.input_files, 'green')}. The reflection output was saved as {colored(self.reflect_output_file, 'green')}"
        )

        return state, messages

    def run(self):
        self.setup()
        state, messages = self.process()
        if self.args.reflect:
            state, messages = self.reflect(state, messages)
        log_end(self.log_file)
        return state, messages


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.first_round_output_files = []
        self.reflect_round_output_files = []

    def get_output_file(self, round=0):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = self.output_settings["output_type"]
        return get_output_file_name(base_output_file, self.args.agent, self.model_settings["model"], file_extension, round)

    def handle_output(self, state, end_turn, output_file, is_reflection_complete=False):
        if end_turn:
            ensure_correct_xml_structure(output_file, self.agent_settings["document_tag"])

            if self.args.output_files:  # Multiple output files
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_multiple_outputs(output_files)
                if is_reflection_complete:
                    self.reflect_round_output_files = output_files
                else:
                    self.first_round_output_files = output_files
            else:  # Single output file
                output_file = split_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_single_output(output_file)
                if is_reflection_complete:
                    self.reflect_round_output_files = [output_file]
                else:
                    self.first_round_output_files = [output_file]

            if is_reflection_complete:
                self._handle_reflection_diff(end_turn)

        log_output_files(output_file, self.log_file)
        log_and_print_statistics(state, self.args.model, self.log_file)

    def _handle_reflection_diff(self, end_turn):
        if self.output_settings["output_type"] == "tex":
            if self.args.output_files:
                for input_file, first_output, reflect_output in zip(self.args.input_files, self.first_round_output_files, self.reflect_round_output_files):
                    if os.path.exists(input_file) and os.path.exists(first_output) and os.path.exists(reflect_output):
                        run_latexdiff(input_file, first_output, self.args.agent, self.args.model)
                        run_latexdiff(input_file, reflect_output, self.args.agent, self.args.model)
                        run_latexdiff(first_output, reflect_output, self.args.agent, self.args.model, suffix="_diffdiff")
                    else:
                        print(f"Warning: Could not generate latexdiff for reflection. Files not found: {input_file}, {first_output}, or {reflect_output}")
            else:
                input_file = self.args.input_file
                first_output = self.first_round_output_files[0] if self.first_round_output_files else None
                reflect_output = self.reflect_round_output_files[0] if self.reflect_round_output_files else None
                if input_file and first_output and reflect_output and os.path.exists(input_file) and os.path.exists(first_output) and os.path.exists(reflect_output):
                    run_latexdiff(input_file, first_output, self.args.agent, self.args.model)
                    run_latexdiff(input_file, reflect_output, self.args.agent, self.args.model)
                    run_latexdiff(first_output, reflect_output, self.args.agent, self.args.model, suffix="_diffdiff")
                else:
                    print(f"Warning: Could not generate latexdiff for reflection. Files not found: {input_file}, {first_output}, or {reflect_output}")


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.first_round_output_files = []
        self.reflect_round_output_files = []

    def get_output_file(self, round=0):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = self.output_settings["output_type"]
        return get_output_file_name(base_output_file, self.args.agent, self.model_settings["model"], file_extension, round=round)

    def handle_output(self, state, end_turn, output_file, is_reflection_complete=False):
        if end_turn:
            if self.args.output_files:  # Multiple output files
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_multiple_outputs(output_files)
                if is_reflection_complete:
                    self.reflect_round_output_files = output_files
                else:
                    self.first_round_output_files = output_files
            else:  # Single output file
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings["document_tag"])
                self._handle_single_output(processed_output_file)
                if is_reflection_complete:
                    self.reflect_round_output_files = [processed_output_file]
                else:
                    self.first_round_output_files = [processed_output_file]

            if is_reflection_complete:
                self._handle_reflection_diff(end_turn)

        log_output_files(output_file, self.log_file)
        log_and_print_statistics(state, self.args.model, self.log_file)

    def _handle_reflection_diff(self, end_turn):
        if self.output_settings["output_type"] == "tex":
            if self.args.output_files:
                for first_output, reflect_output in zip(self.first_round_output_files, self.reflect_round_output_files):
                    if os.path.exists(first_output) and os.path.exists(reflect_output):
                        run_latexdiff(first_output, reflect_output, self.args.agent, self.args.model)
                    else:
                        print(f"Warning: Could not generate latexdiff for reflection. Files not found: {first_output} or {reflect_output}")
            else:
                first_output = self.first_round_output_files[0] if self.first_round_output_files else None
                reflect_output = self.reflect_round_output_files[0] if self.reflect_round_output_files else None
                if first_output and reflect_output and os.path.exists(first_output) and os.path.exists(reflect_output):
                    run_latexdiff(first_output, reflect_output, self.args.agent, self.args.model)
                else:
                    print(f"Warning: Could not generate latexdiff for reflection. Files not found: {first_output} or {reflect_output}")
