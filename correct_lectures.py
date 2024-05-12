import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor


# Define the settings for each mode
all_tasks_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "\\documentclass{article}\n\\usepackage[utf8]{inp",
    },
    "correct_qi": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "\\documentclass{lecture}\n\\input{commands_qi}\n\\course{",
    },
    "correct_st": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "\\documentclass{lecture}\n\\input{command}\n\\course{",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process TeX files with AI-assisted revision."
    )
    parser.add_argument(
        "input_file", type=str, help="Path to the TeX file to be processed."
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
        default="correct",
        help="Mode of operation, either 'correct', 'correct_st', 'correct_qi'.",
        choices=["correct", "correct_st", "correct_qi"],
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "input_file": os.path.basename(args.input_file),
        "input_content": read_file(args.input_file),
    }


    if args.task == "correct_qi":
        user_prefix_input_vars["document_cls_content"] = read_file("lecture.cls")
        user_prefix_input_vars["commands_content"] = read_file("commands_qi.tex")
    elif args.task == "correct_st":
        user_prefix_input_vars["document_cls_content"] = read_file("lecture.cls")
        user_prefix_input_vars["commands_content"] = read_file("command.tex")

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_claude(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        model=args.model,
        prompt_path=args.prompt_path,
    )


if __name__ == "__main__":
    main()
