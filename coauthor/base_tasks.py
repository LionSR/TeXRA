import os
from abc import ABC, abstractmethod
from termcolor import colored
import coauthor as coa
import os


def get_output_file_name(input_file, task, model, output_type, reflect=False):
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_type = output_type.strip(".")
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    if reflect:
        output_file = output_file.replace(f"_{model}", f"_reflect_{model}")
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


class BaseReflectChainTask(ABC):
    """
    Abstract base class for reflect chain tasks.
    Provides a common structure for tasks that involve reflection and processing.
    """

    def __init__(self, args, prompt_path):
        self.args = args
        self.prompt_path = prompt_path
        self.task_settings = None
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

        self.task_settings, self.prompt_dict = coa.load_task_settings_and_prompts(self.prompt_path, self.args.task)
        self.user_vars = self.get_user_vars()
        self.model_settings = coa.get_model_settings(self.args)
        self.output_settings = coa.get_output_settings(self.args, self.task_settings)
        self.prompt_settings = coa.get_prompt_settings(self.args, self.prompt_path, self.prompt_dict)
        self.client = coa.get_model_client(self.model_settings["model"])
        self.log_file = coa.log_start(self.args)
        self.use_scratchpad = "<scratchpad>" in self.output_settings["prefill_first"]
        self.output_file = self.get_output_file()
        self.reflect_output_file = self.get_reflect_output_file()

    @abstractmethod
    def get_user_vars(self):
        pass

    @abstractmethod
    def process(self):
        pass

    @abstractmethod
    def handle_output(self, state, end_turn, output_file):
        pass

    @abstractmethod
    def reflect(self, state, messages):
        pass

    @abstractmethod
    def get_output_file(self):
        pass

    @abstractmethod
    def get_reflect_output_file(self):
        pass

    def run(self):
        self.setup()
        state, messages = self.process()
        if self.args.reflect:
            state, messages = self.reflect(state, messages)
        coa.log_end(self.log_file)
        return state, messages


class ThinkWrite(BaseReflectChainTask):
    def get_output_file(self):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        file_extension = "xml" if self.use_scratchpad else self.output_settings["output_type"]
        return coa.get_output_file_name(base_output_file, self.args.task, self.model_settings["model"], file_extension)

    def get_reflect_output_file(self):
        if self.args.reflect:
            base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
            return coa.get_output_file_name(
                base_output_file,
                self.args.task,
                self.model_settings["model"],
                self.output_settings["output_type"],
                reflect=True,
            )
        return None

    def process(self):
        state, accumulated_output, end_turn, messages = coa.process_first_round(
            self.client,
            self.args.task,
            self.args.input_file,
            self.output_file,
            self.user_vars,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=self.args.figure_inputs,
        )

        self.handle_output(state, end_turn, self.output_file)
        return state, messages

    def handle_output(self, state, end_turn, output_file):
        if end_turn and self.output_settings["output_type"] == "tex":
            coa.ensure_correct_xml_structure(output_file, self.task_settings["document_tag"])
            
            if self.args.output_files:  # Multiple output files
                output_files = coa.split_multiple_scratchpad_output_xml(output_file, self.task_settings["document_tag"])
                self._handle_multiple_outputs(output_files)
            else:  # Single output file
                output_file = coa.split_scratchpad_output_xml(output_file, self.task_settings["document_tag"])
                self._handle_single_output(output_file)

        coa.log_output_files(output_file, self.log_file)
        coa.log_and_print_statistics(state, self.args.model, self.log_file)

        self._handle_reflection_diff(end_turn)

    def _handle_single_output(self, output_file):
        coa.run_latexdiff(self.args.input_file, output_file, self.args.task)

    def _handle_multiple_outputs(self, output_files):
        for input_file, output_file in zip(self.args.output_files, output_files):
            coa.log_output_files(output_file, self.log_file)
            coa.run_latexdiff(input_file, output_file, self.args.task)

    def _handle_reflection_diff(self, end_turn):
        if self.args.reflect and end_turn:
            if self.args.output_files:  # Multiple output files
                for input_file, output_file in zip(self.args.input_files or [self.args.input_file], self.args.output_files):
                    self._generate_reflection_diff(input_file, output_file)
            else:  # Single output file
                self._generate_reflection_diff(self.args.input_file, None)

    def _generate_reflection_diff(self, input_file, output_file):
        first_output = self.get_output_file()
        reflect_output = self.get_reflect_output_file()
        if os.path.exists(first_output) and os.path.exists(reflect_output):
            coa.run_latexdiff(first_output, reflect_output, f"{self.args.task}_reflect_diff", self.args.model)
        else:
            print(f"Warning: Could not generate latexdiff for reflection. Files not found: {first_output} or {reflect_output}")

    def reflect(self, state, messages):
        reflection_figure_inputs = []

        # Extract TikZ pictures if include_tikz_reflection is set
        if self.prompt_settings.get("include_tikz_reflection"):
            generated_output_file = coa.get_output_file_name(
                self.args.input_file,
                self.args.task,
                self.model_settings["model"],
                self.output_settings["output_type"],
                reflect=False
            )
            print(f"Extracting TikZ figures from {generated_output_file}")
            extracted_tikz_figures = coa.extract_and_compile_tikzpictures_with_labels(generated_output_file)
            if extracted_tikz_figures:
                reflection_figure_inputs.extend(extracted_tikz_figures)

        state, accumulated_output, end_turn, messages = coa.process_reflection_round(
            self.client,
            self.args.task,
            self.args.input_file,
            self.reflect_output_file,
            state,
            messages,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=reflection_figure_inputs
        )

        self.handle_output(state, end_turn, self.reflect_output_file)
        return state, messages


class DirectWrite(BaseReflectChainTask):
    def get_output_file(self):
        base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
        return coa.get_output_file_name(base_output_file, self.args.task, self.model_settings["model"], self.output_settings["output_type"])

    def get_reflect_output_file(self):
        if self.args.reflect:
            base_output_file = self.args.output_name_override if self.args.output_name_override else self.args.input_file
            return coa.get_output_file_name(
                base_output_file,
                self.args.task,
                self.model_settings["model"],
                self.output_settings["output_type"],
                reflect=True,
            )
        return None

    def process(self):
        state, accumulated_output, end_turn, messages = coa.process_first_round(
            self.client,
            self.args.task,
            self.args.input_file,
            self.output_file,
            self.user_vars,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
            figure_inputs=self.args.figure_inputs,
        )
        self.handle_output(state, end_turn, self.output_file)
        return state, messages

    def handle_output(self, state, end_turn, output_file):
        if end_turn and self.output_settings["output_type"] == "tex":
            coa.run_latexdiff(self.args.input_file, output_file, self.args.task)

        coa.log_output_files(output_file, self.log_file)
        coa.log_and_print_statistics(state, self.args.model, self.log_file)

        self._handle_reflection_diff(end_turn)

    def _handle_reflection_diff(self, end_turn):
        if self.args.reflect and end_turn:
            if os.path.exists(self.output_file) and os.path.exists(self.reflect_output_file):
                coa.run_latexdiff(self.output_file, self.reflect_output_file, f"{self.args.task}_reflect_diff", self.args.model)
            else:
                print(f"Warning: Could not generate latexdiff for reflection. Files not found: {self.output_file} or {self.reflect_output_file}")

    def reflect(self, state, messages):
        state, accumulated_output, end_turn, messages = coa.process_reflection_round(
            self.client,
            self.args.task,
            self.args.input_file,
            self.reflect_output_file,
            state,
            messages,
            model_settings=self.model_settings,
            output_settings=self.output_settings,
            prompt_settings=self.prompt_settings,
        )

        self.handle_output(state, end_turn, self.reflect_output_file)
        return state, messages
