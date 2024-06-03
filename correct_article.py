import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path


# Define the settings for the "correct" mode tailored for research papers
all_tasks_settings = {
    "correct_main": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
    },
    "correct_article": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
    },
}

prompt_path = get_prompt_path(coauthor, "article")


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
    }
    if args.task == "correct_article":
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_file)
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_file)

    task_settings = all_tasks_settings[args.task]

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

    # Call latexdiff to diff the generated/output file with the input to a file ends with _diff_opus.txt
    input_file_name = os.path.basename(args.input_file)
    diff_file_name = output_file.replace(f"{args.model}.tex", f"diff_{args.model}.tex")
    latexdiff_command = f"latexdiff {input_file_name} {output_file} > {diff_file_name}"
    print(colored(f"Running latexdiff command: {latexdiff_command}", "green"))
    os.system(latexdiff_command)


if __name__ == "__main__":
    main()
