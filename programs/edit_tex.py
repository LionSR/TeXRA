import os
from datetime import datetime
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
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        "system_prompt_file": "system_prompt_draw.txt",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
}


def main():
    parser = get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct",
        help="The task to be performed.",
        choices=["correct", "polish", "draw"],
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

    if args.auxiliary_files:
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_files)
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files)
        task_settings["user_prefix_file"] = task_settings["user_prefix_file"].replace(".txt", "_with_auxiliary.txt")
        print(colored(f"Using auxiliary file: {args.auxiliary_files}", "green"))

    log_file_name = args.input_file.replace(".tex", "_log.txt")
    with open(log_file_name, "a+") as log_file:
        log_file.write(f"Start logging: {datetime.now()}\n")
        log_file.write(f"Task: {args.task}\n")
        log_file.write(f"Model: {args.model}\n")
        log_file.write(f"Instruction:\n<request>\n{args.instruction}\n</request>\n\n")

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        use_prefill_from_input=False,
        append_mode=args.append_mode,
        figure_inputs=args.figure_inputs if args.figure_inputs else None,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    if args.reflect and end_turn:
        state, accumulated_output, end_turn, output_file_reflect, messages = coauthor.process_reflection(
            args.task,
            task_settings,
            args.input_file,
            output_file,
            state,
            accumulated_output,
            messages,
            model_settings,
            output_settings,
            prompt_path,
            use_prefill_from_input=False,
        )

        print(colored(f"Reflect mode is on. Output files: {output_file}, {output_file_reflect}", "yellow"))
        run_latexdiff(args.input_file, output_file_reflect)
    else:
        output_file_reflect = None


if __name__ == "__main__":
    main()
