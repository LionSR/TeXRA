from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, process_reflection_round
from coauthor.prompt_utils import get_user_prefix_vars, handle_long_input
from coauthor.edit_utils import (
    get_llm_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files

prompt_path = get_prompt_path(coauthor, "lecture")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
}


def main():
    parser = get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        choices=["correct_qi", "correct_st", "polish_qi", "polish_st", "draw_st", "draw_qi", "polish_st_long", "draw_st_long", "correct_st_long"],
    )
    parser.add_argument("--append_mode", type=bool, default=True, help="Whether to append the output to the input file instead of overwriting it.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]
    task_sub = args.task.split("_")[0] + "_" + args.task.split("_")[1]

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars["DOCUMENT_CLS"] = "lecture.cls"
    user_prefix_vars["DOCUMENT_CLS_CONTENT"] = coauthor.read_file("lecture.cls")
    user_prefix_vars["COMMANDS"] = "commands_qi.tex" if "qi" in args.task else "command.tex"
    user_prefix_vars["COMMANDS_CONTENT"] = coauthor.read_file(user_prefix_vars["COMMANDS"])

    task_settings = all_task_settings.get(task_shared, {})
    task_settings.setdefault("system_prompt_file", f"system_prompt_{task_sub}.txt")
    task_settings.setdefault("user_prefix_file", f"user_prefix_{task_sub}.txt")
    task_settings.setdefault("user_request_file", f"user_request_{task_sub}.txt")

    if "long" in args.task:
        handle_long_input(args, user_prefix_vars, task_settings)
    elif args.input_files:
        raise ValueError("Input files are not allowed for non-long tasks. Please use --task=polish_long or --task=draw_long instead.")

    log_file_path = log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_first_round(
        args.task, task_settings, args.input_file, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output, end_turn, output_file_reflect, messages = process_reflection_round(
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
        print(colored(f"Reflect mode is on. Output files: {output_file_reflect}", "yellow"))
        log_file_reflect = output_file_reflect.replace(".tex", "_log.txt")
        log_output_files(log_file_path, output_file_reflect)
        log_and_print_statistics(state, args.model, log_file_reflect)

        run_latexdiff(args.input_file, output_file_reflect)
        run_latexdiff(output_file, output_file_reflect, args.model)


if __name__ == "__main__":
    main()
