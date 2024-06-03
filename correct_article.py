import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path


task_settings = {
    "document_tag": "latex_document",
    "end_tag": "</latex_document>",
    "output_type": "tex",
    "first_prefill": "Here is the revised latex document. <latex_document>",
}

prompt_path = get_prompt_path(coauthor, "article")


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
        help="The task to be performed.",
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

    if args.auxiliary_file:
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_file)
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_file)

    state, accumulated_output, end_turn, output_file = coauthor.process_file_with_llm(
        "correct",
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        use_prefill_from_input=False,
        append_mode=args.append_mode,
    )

    # Call latexdiff to diff the generated/output file with the input to a diff file
    diff_file_name = output_file.replace(f"{args.model}.tex", f"diff_{args.model}.tex")
    latexdiff_command = f"latexdiff {args.input_file} {output_file} > {diff_file_name}"
    print(colored(f"Running latexdiff command: {latexdiff_command}", "green"))
    os.system(latexdiff_command)


if __name__ == "__main__":
    main()
