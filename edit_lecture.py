import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path, run_latexdiff

prompt_path = get_prompt_path(coauthor, "lecture")

# Define the settings for the tasks
all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
    },
}


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        help="Mode of operation, either 'correct_qi', 'correct_st'.",
        choices=["correct_qi", "correct_st"],
    )
    parser.add_argument(
        "--append_mode",
        type=bool,
        default=True,
        help="Whether to append the output to the input file instead of overwriting it.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
    }
    if "correct" in args.task:
        task_settings = all_task_settings["correct"]
        if "qi" in args.task:
            user_prefix_vars["COMMANDS_CONTENT"] = read_file("commands_qi.tex")
        elif "st" in args.task:
            user_prefix_vars["COMMANDS_CONTENT"] = read_file("command.tex")

    task_settings["system_prompt_file"] = f"system_prompt_{args.task}.txt"
    task_settings["user_prefix_file"] = f"user_prefix_{args.task}.txt"
    task_settings["user_request_file"] = f"user_request_{args.task}.txt"

    state, accumulated_output, end_turn, output_file = coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        use_prefill_from_input=False,
        append_mode=args.append_mode,
    )

    run_latexdiff(args.input_file, output_file, args.model)


if __name__ == "__main__":
    main()
