import os
from datetime import datetime
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path, run_latexdiff
from coauthor.process import process_file_with_llm, process_reflection
from coauthor.model_utils import get_summary_string

prompt_path = get_prompt_path(coauthor, "article")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
        "system_prompt_file": "system_prompt_correct.txt",
        "user_prefix_file": "user_prefix_correct.txt",
        "user_request_file": "user_request_correct.txt",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "system_prompt_file": "system_prompt_draw.txt",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
}


def main():
    parser = get_common_argparser()
    parser.add_argument("--task", type=str, default="correct", choices=["correct", "polish", "draw", "polish_long", "draw_long"])
    parser.add_argument("--append_mode", type=bool, default=True, help="Whether to append the output to the input file instead of overwriting it.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "INSTRUCTION": args.instruction,
    }

    task_settings = all_task_settings[task_shared]

    if "long" in args.task:
        task_settings["user_prefix_file"] = f"user_prefix_{task_shared}_long.txt"
        user_prefix_vars["AUXILIARY_FILES"] = get_auxiliary_files_content(args.auxiliary_files)
        user_prefix_vars["ADDITIONAL_INPUT_FILES"] = get_additional_input_files_content(args.input_files, len(args.auxiliary_files))
    else:
        handle_non_long_task(args, user_prefix_vars, task_settings)

    log_start(args)

    llm_settings = {
        "model": args.model,
        "api_key": None,  # Add API key if needed
        "prompt_path": prompt_path,
        "figure_inputs": args.figure_inputs,
        "max_tokens": 4096,  # Adjust as needed
        "temperature": 0,  # Adjust as needed
    }

    output_settings = {
        "document_tag": task_settings["document_tag"],
        "end_tag": task_settings["end_tag"],
        "use_prefill_from_input": False,
        "append_mode": args.append_mode,
        "overwrite": False,
        "k": 200,  # Adjust as needed
    }

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_file_with_llm(
        args.task, task_settings, args.input_file, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_summary(args, state)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file)


def get_auxiliary_files_content(auxiliary_files):
    return format_file_content(auxiliary_files, 2) if auxiliary_files else ""


def get_additional_input_files_content(input_files, num_auxiliary_files):
    return format_file_content(input_files, num_auxiliary_files + 2) if input_files else ""


def format_file_content(files, start_index):
    return "\n".join(
        f'<document index="{i+start_index}">\n'
        f"    <source>{os.path.basename(file)}</source>\n"
        f"    <document_content>\n"
        f"        {read_file(file)}\n"
        f"    </document_content>\n"
        f"</document>"
        for i, file in enumerate(files)
    )


def handle_non_long_task(args, user_prefix_vars, task_settings):
    if args.input_files:
        raise ValueError("Input files are not allowed for non-long tasks. Please use --task=polish_long or --task=draw_long instead.")
    if args.auxiliary_files:
        if len(args.auxiliary_files) > 1:
            raise ValueError("Only one auxiliary file is allowed. Please provide a single file.")
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_files[0])
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])
        task_settings["user_prefix_file"] = task_settings["user_prefix_file"].replace(".txt", "_with_auxiliary.txt")


def log_start(args):
    with open(args.input_file.replace(".tex", "_log.txt"), "a+") as log_file:
        log_file.write(
            f"Start logging: {datetime.now()}\nTask: {args.task}\nModel: {args.model}\nInstruction:\n<request>\n{args.instruction}\n</request>\n"
        )


def log_summary(args, state):
    summary = get_summary_string(state, args.model)
    print(f"Summary: {summary}")
    with open(args.input_file.replace(".tex", "_log.txt"), "a") as log_file:
        log_file.write(f"Summary:\n{summary}\n")


def handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file):
    state, accumulated_output, end_turn, output_file_reflect, messages = process_reflection(
        args.task,
        task_settings,
        args.input_file,
        output_file,
        state,
        accumulated_output,
        messages,
        model_settings,
        output_settings,
        prompt_path,
        use_prefill_from_input=False,
    )
    print(colored(f"Reflect mode is on. Output files: {output_file}, {output_file_reflect}", "yellow"))
    run_latexdiff(args.input_file, output_file_reflect)
    run_latexdiff(output_file, output_file_reflect, args.model)

    reflection_summary = get_summary_string(state, args.model)
    print(f"Reflection summary: {reflection_summary}")

    with open(args.input_file.replace(".tex", "_log.txt"), "a") as log_file:
        log_file.write(f"Reflection summary:\n{reflection_summary}\n")


if __name__ == "__main__":
    main()
