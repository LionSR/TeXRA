import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path


# Define the settings for each mode
all_tasks_settings = {
    "correct_qi": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "Now output the revised document. <latex_document>",
    },
    "correct_st": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "Here is the revised document. <latex_document>",
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

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
    }

    if args.task == "correct_qi":
        user_prefix_vars["DOCUMENT_CLS_CONTENT"] = read_file("lecture.cls")
        user_prefix_vars["COMMANDS_CONTENT"] = read_file("commands_qi.tex")
        prompt_path = get_prompt_path(coauthor, "lecture_qi")
    elif args.task == "correct_st":
        user_prefix_vars["DOCUMENT_CLS_CONTENT"] = read_file("lecture.cls")
        user_prefix_vars["COMMANDS_CONTENT"] = read_file("command.tex")
        prompt_path = get_prompt_path(coauthor, "lecture_st")

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
    )


if __name__ == "__main__":
    main()
