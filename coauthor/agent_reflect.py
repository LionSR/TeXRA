import os
from termcolor import colored, cprint
from abc import ABC, abstractmethod
from .figure_tools import extract_and_compile_tikzpictures_with_labels
from .process import process_first_round, process_reflection_round
from .model_utils import get_model_client, get_model_settings
from .tex_tools import run_latexdiff, get_tex_count
from .output_utils import (
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
)
from .log_utils import log_start, log_end, log_and_print_statistics, log_output_files
from .prompt_utils import load_agent_settings_and_prompts
from .settings_utils import get_output_settings, get_prompt_settings
import re


def get_output_file_name(input_file, agent, model, output_type, round, edited_file=None):
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]
    output_type = output_type.strip(".")

    if edited_file:
        # Extract the round number from the edited file
        edited_round = int(re.search(r"_r(\d+)_", edited_file).group(1))
        new_round = edited_round + round + 1
    else:
        new_round = round

    output_file = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{output_type}"
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
        self.output_file = {0: None, 1: None}
        self.output_files = {0: [], 1: []}
        if self.args.output_files:
            self.base_files = self.args.output_files
        else:
            self.base_files = [self.args.input_file]
        self.edited_file = args.edited_file if hasattr(args, "edited_file") else None
        self.use_prompt_caching = self.args.use_prompt_caching if hasattr(self.args, "use_prompt_caching") else False

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
        self.use_scratchpad = "<scratchpad>" in self.output_settings["prefills"][0] if self.output_settings["prefills"] else False
        self.output_file[0] = self.get_output_file(round=0)
        self.output_file[1] = self.get_output_file(round=1)

    @abstractmethod
    def get_user_vars(self):
        pass

    @abstractmethod
    def handle_output(self, state, end_turn, output_file, round=0):
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
                with open(self.args.input_file, encoding="utf-8") as f:
                    content = f.read()
                    return content[:k].strip()  # Return only the first k characters, stripped
            except OSError as e:
                print(f"Error reading file {self.args.input_file}: {e}")
        return None

    def _run_latexdiff_for_round(self, input_file, output_file, round):
        if input_file and output_file and os.path.exists(input_file) and os.path.exists(output_file):
            run_latexdiff(input_file, output_file, self.args.agent, suffix="_diff")
        else:
            print(f"Warning: Could not generate latexdiff for round {round}. Files not found: {input_file} or {output_file}")

    def _run_latexdiff_between_rounds(self, first_output, second_output):
        if first_output and second_output and os.path.exists(first_output) and os.path.exists(second_output):
            first_round = re.search(r"_r(\d+)_", first_output).group(1)
            second_round = re.search(r"_r(\d+)_", second_output).group(1)
            diff_suffix = f"_diffr{second_round}r{first_round}"
            run_latexdiff(first_output, second_output, self.args.agent, suffix=diff_suffix)
        else:
            print(f"Warning: Could not generate latexdiff between rounds. Files not found: {first_output} or {second_output}")

    def _handle_latexdiff(self, round):
        cprint(f"Handling latexdiff for {self.args.agent} in round {round}", "blue", "on_white")

        print(f"base_files: {self.base_files}")
        print(f"#{round} output_files : {self.output_files[round]}")

        for i, (base_file, first_output) in enumerate(zip(self.base_files, self.output_files[round])):
            # Compare original input with round r output
            self._run_latexdiff_for_round(base_file, first_output, round)

        for r in range(1, round + 1):
            cprint(f"Comparing round {r-1} with round {r}", "blue", "on_white")
            # Compare round r-1 output with round r output
            for i, (base_file, output_file) in enumerate(zip(self.output_files[r - 1], self.output_files[r])):
                self._run_latexdiff_between_rounds(base_file, output_file)

    def _replace_input_commands(self, base_files, output_files):
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
        tex_count_stats = self._get_tex_count_stats(input_files)
        first_k_tex_document = self._get_first_k_tex_document()
        state, accumulated_output, end_turn, messages = process_first_round(
            self.client,
            self.output_file[0],
            self.user_vars,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=self.args.figure_inputs,
            tex_count_stats=tex_count_stats,
            first_k_tex_document=first_k_tex_document,
        )

        self.handle_output(state, end_turn, self.output_file[0], round=0)

        print(
            f"\n\nProcessed input files {colored(', '.join(input_files), 'green')}. "
            f"The output was saved as {colored(self.output_file[0], 'green')}"
        )

        return state, messages

    def reflect(self, state, messages):
        reflection_figure_inputs = []
        if self.args.output_files:
            tex_count_stats = self._get_tex_count_stats(self.args.output_files)
            if self.prompt_settings.get("include_tikz_reflection"):
                # Handle multiple output files
                for output_file in self.args.output_files:
                    print(f"Extracting TikZ figures from {output_file}")
                    extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(output_file)
                    if extracted_tikz_figures:
                        reflection_figure_inputs.extend(extracted_tikz_figures)
        else:
            generated_output_file = get_output_file_name(
                self.args.input_file,
                self.args.agent,
                self.model_settings["model"],
                self.output_settings["output_type"],
                round=0,
                edited_file=self.edited_file,
            )
            tex_count_stats = self._get_tex_count_stats(generated_output_file)
            if self.prompt_settings.get("include_tikz_reflection"):
                print(f"Extracting TikZ figures from {generated_output_file}")
                extracted_tikz_figures = extract_and_compile_tikzpictures_with_labels(generated_output_file)
                if extracted_tikz_figures:
                    reflection_figure_inputs.extend(extracted_tikz_figures)

        first_k_tex_document = self._get_first_k_tex_document()
        state, accumulated_output, end_turn, messages = process_reflection_round(
            self.client,
            self.output_file[1],  # Use the singular version
            state,
            messages,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=reflection_figure_inputs,
            tex_count_stats=tex_count_stats,
            first_k_tex_document=first_k_tex_document,
        )
        self.handle_output(state, end_turn, self.output_file[1], round=1)

        print(
            f"\n\nProcessed input file {colored(self.args.input_file, 'green')} "
            f"and/or additional input files {colored(self.args.input_files, 'green')}. "
            f"The reflection output was saved as {colored(self.output_file[1], 'green')}"
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

    def get_output_file(self, round=0):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = self.output_settings["output_type"]
        return get_output_file_name(base_output_file, self.args.agent, self.model_settings["model"], file_extension, round, self.edited_file)

    def handle_output(self, state, end_turn, output_file, round=0):
        if end_turn:
            ensure_correct_xml_structure(output_file, self.agent_settings["document_tag"])

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
        log_and_print_statistics(state, self.args.model, self.log_file)


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)

    def get_output_file(self, round=0):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = self.output_settings["output_type"]
        return get_output_file_name(base_output_file, self.args.agent, self.model_settings["model"], file_extension, round, self.edited_file)

    def handle_output(self, state, end_turn, output_file, round=0):
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
        log_and_print_statistics(state, self.args.model, self.log_file)
