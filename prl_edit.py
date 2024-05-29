# correct_article.py
import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor


# Define the settings for the "correct" mode tailored for research papers
all_tasks_settings = {
    "correct_prl": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        # "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "Now we output the corrected supp.tex as follows.\n<latex_document>",
        # "first_prefill": "\\documentclass[aps,prl,twocolumn,superscriptaddress,nolongbibliography,nobalancelastpage,10pt]{revtex4-2}\n\\input{preamble}\n\\graphicspath",
    },
    "correct_supp_prl": {
        "document_tag": "latex_document",
        "output_type": "tex",
        "end_tag": "</latex_document>",
        "first_prefill": "Now we output the corrected supp.tex as follows.\n<latex_document>",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process TeX files of research papers with AI-assisted revision."
    )
    parser.add_argument(
        "--input_file", type=str, help="Path to the TeX file to be processed."
    )
    parser.add_argument(
        "--auxiliary_file",
        type=str,
        help="Path to the auxiliary TeX file to be processed.",
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
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts/prl_edit",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
    }
    user_prefix_input_vars["PREAMBLE_CONTENT"] = read_file("preamble.tex")

    if args.task == "correct_prl":
        user_prefix_input_vars["SUPP_CONTENT"] = read_file("supp.tex")
    elif args.task == "correct_supp_prl":
        user_prefix_input_vars["main_content"] = read_file(args.auxiliary_file)

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
