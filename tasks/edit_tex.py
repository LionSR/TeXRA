from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, handle_reflection
from coauthor.prompt_utils import get_user_prefix_vars, handle_long_input, handle_single_input
from coauthor.settings_utils import (
    get_model_settings,
    get_output_settings,
    get_prompt_settings,
)
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files

prompt_path = get_prompt_path(coauthor, "article")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "Here is the revised latex document. <latex_document>",
        "system_prompt_file": "system_prompt_correct.txt",
        "user_prefix_file": "user_prefix_correct.txt",
        "user_request_file": "user_request_correct.txt",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_draw.txt",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
}


def main():
    parser = get_common_argparser()
    parser.add_argument("--task", type=str, default="correct", choices=["correct", "polish", "draw", "polish_long", "draw_long"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]

    user_prefix_vars = get_user_prefix_vars(args)
    task_settings = all_task_settings[task_shared]

    log_file_path = log_start(args)

    model_settings = get_model_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)
    prompt_settings = get_prompt_settings(args, task_settings)

    if "long" in args.task:
        handle_long_input(args, user_prefix_vars, prompt_settings)
    else:
        handle_single_input(args, user_prefix_vars, prompt_settings)

    # Determine whether to continue or start new
    state = None
    accumulated_output = None
    messages = None

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_first_round(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model_settings,
        output_settings,
        state=state,
        accumulated_output=accumulated_output,
        messages=messages,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_statistics(state, args.model, log_file_path)
    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
