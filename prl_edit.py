# correct_article.py
import os
from termcolor import colored

from coauthor import read_file
import coauthor
from coauthor.argparse_utils import get_common_argparser


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

prompt_path = os.path.join(os.path.dirname(coauthor.__file__), "prompts/prl_edit")


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--auxiliary_file",
        type=str,
        help="Path to the auxiliary TeX file to be processed.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
    }
    user_prefix_vars["PREAMBLE_CONTENT"] = read_file("preamble.tex")

    if args.task == "correct_prl":
        user_prefix_vars["SUPP_CONTENT"] = read_file("supp.tex")
    elif args.task == "correct_supp_prl":
        user_prefix_vars["main_content"] = read_file(args.auxiliary_file)

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
