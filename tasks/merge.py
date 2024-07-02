from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, process_reflection_round
from coauthor.prompt_utils import handle_single_input
from coauthor.settings_utils import get_model_settings, get_output_settings, get_prompt_settings
from coauthor.model_utils import get_model_client
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files

# Define the settings for each mode
all_tasks_settings = {
    "merge": {
        "document_tag": "edited_file",
        "end_tag": ["\\end{document}", "</edited_file>"],
        "output_type": "tex",
        "prefill_first": "<edited_file>",
    },
}

prompt_path = get_prompt_path(coauthor, "merge")


def main():
    parser = get_common_argparser()
    # parser.add_argument("--input_file", type=str, help="Path to the original LaTeX document.")
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--task", type=str, default="merge", help="Task to perform.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Merging {args.input_file} and {args.edited_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": args.input_file,
        "ORIGINAL_LATEX": coauthor.read_file(args.input_file),
        "EDITED_LATEX": coauthor.read_file(args.edited_file),
    }

    task = args.task
    task_settings = all_tasks_settings[task]

    log_file_path = log_start(args)

    model_settings = get_model_settings(args)
    output_settings = get_output_settings(args, task_settings)
    prompt_settings = get_prompt_settings(args, prompt_path, task_settings, task)

    handle_single_input(args, user_prefix_vars, prompt_settings)

    client = get_model_client(model_settings["model"])

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = process_first_round(
        client,
        task,
        args.input_file,
        user_prefix_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_output_files(output_file, log_file_path)
    log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = process_reflection_round(
            client,
            task,
            args.input_file,
            state,
            messages,
            model_settings=model_settings,
            output_settings=output_settings,
            prompt_settings=prompt_settings,
        )
        log_output_files(output_file_reflect, log_file_path)
        log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect:
            run_latexdiff(args.input_file, output_file_reflect)
            run_latexdiff(output_file, output_file_reflect, args.model)


if __name__ == "__main__":
    main()
