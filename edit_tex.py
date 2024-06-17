import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path, run_latexdiff


prompt_path = get_prompt_path(coauthor, "article")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
        "system_prompt_file": "system_prompt_correct.txt",
        "user_prefix_file": "user_prefix_correct.txt",
        "user_request_file": "user_request_correct.txt",
    },
    "polish": {
        "document_tag": "updated_latex_document",
        "end_tag": "</updated_latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
}


def main():
    parser = get_common_argparser()
    parser.add_argument(
        "--auxiliary_file",
        type=str,
        default=None,
        help="Path to the auxiliary TeX file to be processed.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="correct",
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

    task_settings = all_task_settings[args.task]

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "INSTRUCTION": args.instruction,
    }

    if args.auxiliary_file:
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_file)
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_file)
        task_settings[
            "user_prefix_file"
        ] = f"user_prefix_{args.task}_with_auxiliary.txt"
        print(colored(f"Using auxiliary file: {args.auxiliary_file}", "green"))

    state, accumulated_output, end_turn, output_file = coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        use_prefill_from_input=False,
        append_mode=args.append_mode,
        reflect=args.reflect,
    )

    run_latexdiff(args.input_file, output_file, args.model)


if __name__ == "__main__":
    main()
