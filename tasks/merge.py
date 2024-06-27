from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, handle_reflection
from coauthor.prompt_utils import get_user_prefix_vars
from coauthor.edit_utils import (
    get_llm_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files


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
    parser.add_argument("--original_latex", type=str, help="Path to the original LaTeX document.")
    parser.add_argument("--edited_latex", type=str, help="Path to the edited LaTeX document.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Merging {args.original_latex} and {args.edited_latex}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "ORIGINAL_LATEX": coauthor.read_file(args.original_latex),
            "EDITED_LATEX": coauthor.read_file(args.edited_latex),
        }
    )

    task = "merge"
    task_settings = all_tasks_settings[task]

    log_file_path = log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_first_round(
        task, task_settings, args.original_latex, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.original_latex, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
