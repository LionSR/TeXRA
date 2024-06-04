import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path


# Define the settings for each mode
all_tasks_settings = {
    "adapt": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
    },
}

prompt_path = get_prompt_path(coauthor, "adapt")


def main():
    parser = get_common_argparser
    parser.add_argument(
        "--sample_tex",
        type=str,
        help="Path to a sample LaTeX file in the desired style.",
    )
    parser.add_argument(
        "--document_cls",
        type=str,
        default="lecture.cls",
        help="Path to the document class file.",
    )
    parser.add_argument(
        "--commands_file",
        type=str,
        default="command.tex",
        help="Path to the file containing custom LaTeX commands.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="adapt",
        help="Mode of operation, either 'adapt'.",
        choices=["adapt"],
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "EXISTING_LECTURE_NOTES": read_file(args.sample_tex),
        "DOCUMENT_CLS_CONTENT": read_file(args.document_cls),
        "COMMANDS_CONTENT": read_file(args.commands_file),
    }

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        reflect=args.reflect,
        use_prefill_from_input=False,
    )


if __name__ == "__main__":
    main()
