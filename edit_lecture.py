import os
from datetime import datetime
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path, run_latexdiff

prompt_path = get_prompt_path(coauthor, "lecture")

# Define the settings for the tasks
all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "Here is the revised latex document. <latex_document>",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
        # "user_prefix_file": "user_prefix_polish.txt",
        # "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
}


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        help="Mode of operation, either 'correct_qi', 'correct_st', 'polish_qi', 'polish_st'.",
        choices=["correct_qi", "correct_st", "polish_qi", "polish_st"],
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
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        # "DOCUMENT_CLS_CONTENT": read_file("exercise.cls"),
        "INSTRUCTION": args.instruction if args.instruction else None,
    }
    if "qi" in args.task:
        user_prefix_vars["COMMANDS_CONTENT"] = read_file("commands_qi.tex")
    elif "st" in args.task:
        user_prefix_vars["COMMANDS_CONTENT"] = read_file("command.tex")
    if "correct" in args.task:
        task_settings = all_task_settings["correct"]
    elif "polish" in args.task:
        task_settings = all_task_settings["polish"]
    task_settings["user_prefix_file"] = f"user_prefix_{args.task}.txt"
    task_settings["user_request_file"] = f"user_request_{args.task}.txt"

    first_task_chunk = args.task.split("_")[0]
    log_file_name = args.input_file.replace(
        ".tex", f"_{first_task_chunk}_log_{args.model}.txt"
    )
    with open(log_file_name, "a+") as log_file:
        log_file.write(f"\nStart logging: {datetime.now()}\n")
        log_file.write(f"\nTask: {args.task}\n")
        log_file.write(f"\nModel: {args.model}\n")
        log_file.write(f"\nInstruction: {args.instruction}\n")

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
        figure_input=args.figure_input if args.figure_input else None,
    )

    if isinstance(output_file, list):
        output_file, output_file_reflect = output_file
        print(
            colored(
                f"Reflect mode is on. Output files: {output_file}, {output_file_reflect}",
                "yellow",
            )
        )
        run_latexdiff(args.model, first_task_chunk, args.input_file, output_file)
        run_latexdiff(
            args.model, first_task_chunk, args.input_file, output_file_reflect
        )
    else:
        print(colored(f"Output file: {output_file}", "yellow"))
        run_latexdiff(args.model, first_task_chunk, args.input_file, output_file)


if __name__ == "__main__":
    main()
