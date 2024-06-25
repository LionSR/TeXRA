from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path


# Define the settings for each mode
all_tasks_settings = {
    "merge": {
        "document_tag": "full_edited_latex",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "<full_edited_latex>",
    },
}

prompt_path = get_prompt_path(coauthor, "merge")


def main():
    parser = get_common_argparser()
    parser.add_argument(
        "--original_latex",
        type=str,
        help="Path to the original LaTeX document.",
    )
    parser.add_argument(
        "--edited_latex",
        type=str,
        help="Path to the edited LaTeX document.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))
    print(colored(f"Merging {args.original_latex} and {args.edited_latex}...\n", "green"))

    user_prefix_vars = {
        "ORIGINAL_LATEX": read_file(args.original_latex),
        "EDITED_LATEX": read_file(args.edited_latex),
    }

    task = "merge"
    task_settings = all_tasks_settings[task]

    coauthor.process_file_with_llm(
        task,
        task_settings,
        args.original_latex,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        reflect=args.reflect,
        use_prefill_from_input=False,
    )


if __name__ == "__main__":
    main()
