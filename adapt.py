import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor


# Define the settings for each mode
all_tasks_settings = {
    "adapt": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        # "first_prefill": "\\documentclass{lecture}\n\\input{command}\n\n\\course{",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process TeX files with AI-assisted revision."
    )
    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the text file generated from the PDF.",
    )
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
        "--model",
        type=str,
        default="sonnet",
        help="Model name to use for processing.",
        choices=["sonnet", "opus", "haiku"],
    )
    parser.add_argument(
        "--task",
        type=str,
        default="adapt",
        help="Mode of operation, either 'adapt'.",
        choices=["adapt"],
    )
    parser.add_argument(
        "--reflect",
        type=bool,
        default=True,
        help="Whether to perform a reflection round after the initial processing.",
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts/adapt",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))
    # print(args)

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "EXISTING_LECTURE_NOTES": read_file(args.sample_tex),
        "DOCUMENT_CLS_CONTENT": read_file(args.document_cls),
        "COMMANDS_CONTENT": read_file(args.commands_file),
    }

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_claude(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        model=args.model,
        prompt_path=args.prompt_path,
        reflect=args.reflect,
        use_prefill_from_input=False,
    )


if __name__ == "__main__":
    main()
