# correct_article.py
import os
from termcolor import colored

from coauthor import read_file
import coauthor
from coauthor.argparse_utils import get_common_argparser


# Define the settings for the "correct" mode tailored for research papers
all_tasks_settings = {
    "correct_main": {
        "document_tag": "latex_document",
        "end_tag": "<latex_document>",
        "output_type": "tex",
        "first_prefill": "Now output the revised document under <latex_document>.",
    },
    "correct_article": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Now output the revised document under <latex_document>.",
    },
}

prompt_path = os.path.join(os.path.dirname(coauthor.__file__), "prompts/article")


def main():
    parser = get_common_argparser()

    # Add additional arguments specific to this file
    parser.add_argument(
        "--auxiliary_file",
        type=str,
        help="Path to the auxiliary TeX file to be processed.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="correct",
        help="Mode of operation, either 'correct_main' or 'correct_article'.",
        choices=["correct_main", "correct_article"],
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
    }
    if args.task == "correct_article":
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_file)
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_file)

    task_settings = all_tasks_settings[args.task]

    prompt_path = os.path.join(args.prompt_path, "article")

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
