from termcolor import colored

import coauthor
from coauthor import get_common_argparser, get_prompt_path, run_latexdiff
from coauthor.process import process_file_with_llm
from coauthor.edit_utils import (
    get_user_prefix_vars,
    handle_long_task,
    handle_non_long_task,
    log_start,
    log_summary,
    handle_reflection,
    get_llm_settings,
    get_output_settings,
)

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

    user_prefix_vars = get_user_prefix_vars(args)
    task_settings = all_task_settings[task_shared]

    if "long" in args.task:
        handle_long_task(args, user_prefix_vars, task_settings)
    else:
        handle_non_long_task(args, user_prefix_vars, task_settings)

    log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        llm_settings,
        output_settings,
        state=state,
        accumulated_output=accumulated_output,
        messages=messages,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_summary(args, state)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
