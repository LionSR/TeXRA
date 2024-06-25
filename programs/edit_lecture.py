import os
from datetime import datetime
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path, run_latexdiff
from coauthor.process import get_summary_string

prompt_path = get_prompt_path(coauthor, "lecture")

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
        "user_prefix_file": "user_prefix_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "first_prefill": "<scratchpad>",
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
        default="correct_qi",
        choices=["correct_qi", "correct_st", "polish_qi", "polish_st", "draw_st", "draw_qi", "polish_st_long", "draw_st_long", "correct_st_long"],
    )
    parser.add_argument("--append_mode", type=bool, default=True, help="Whether to append the output to the input file instead of overwriting it.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]
    task_sub = args.task.split("_")[0] + "_" + args.task.split("_")[1]

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "DOCUMENT_CLS": "lecture.cls",
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        "INSTRUCTION": args.instruction if args.instruction else None,
    }
    if "qi" in args.task:
        user_prefix_vars["COMMANDS"] = "commands_qi.tex"
    elif "st" in args.task:
        user_prefix_vars["COMMANDS"] = "command.tex"
    user_prefix_vars["COMMANDS_CONTENT"] = read_file(user_prefix_vars["COMMANDS"])

    task_settings = all_task_settings.get(task_shared, {})
    task_settings.setdefault("system_prompt_file", f"system_prompt_{task_sub}.txt")
    task_settings.setdefault("user_prefix_file", f"user_prefix_{task_sub}.txt")
    task_settings.setdefault("user_request_file", f"user_request_{task_sub}.txt")

    if "long" in args.task:
        user_prefix_vars["ADDITIONAL_INPUT_FILES"] = (
            "\n".join(
                f'<document index="{i+4}">\n'
                f"    <source>{os.path.basename(input_file)}</source>\n"
                f"    <document_content>\n"
                f"        {read_file(input_file)}\n"
                f"    </document_content>\n"
                f"</document>"
                for i, input_file in enumerate(args.input_files)
            )
            if args.input_files
            else ""
        )
    elif args.input_files:
        raise ValueError("Input files are not allowed for non-long tasks. Please use --task=polish_long or --task=draw_long instead.")

    with open(args.input_file.replace(".tex", "_log.txt"), "a+") as log_file:
        log_file.write(
            f"Start logging: {datetime.now()}\nTask: {args.task}\nModel: {args.model}\nInstruction:\n<request>\n{args.instruction}\n</request>\n"
        )

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        use_prefill_from_input=False,
        append_mode=args.append_mode,
        figure_inputs=args.figure_inputs,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    # Log the summary
    summary = get_summary_string(state, args.model)
    print(f"Summary: {summary}")
    with open(args.input_file.replace(".tex", "_log.txt"), "a") as log_file:
        log_file.write(f"Summary:\n{summary}\n")

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

        run_latexdiff(output_file, output_file_reflect, args.model)

        # Get and log the reflection summary
        reflection_summary = get_summary_string(state, args.model)
        print(f"Reflection summary: {reflection_summary}")

        with open(args.input_file.replace(".tex", "_log.txt"), "a") as log_file:
            log_file.write(f"Reflection summary:\n{reflection_summary}\n")


if __name__ == "__main__":
    main()
