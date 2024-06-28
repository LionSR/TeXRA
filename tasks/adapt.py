from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, process_reflection_round
from coauthor.prompt_utils import get_user_prefix_vars, handle_single_input
from coauthor.settings_utils import get_model_settings, get_output_settings, get_prompt_settings
from coauthor.model_utils import get_model_client
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files

# Define the settings for each mode
all_tasks_settings = {
    "adapt": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
    },
}

prompt_path = get_prompt_path(coauthor, "adapt")


def main():
    parser = get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, default="lecture.cls", help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, default="command.tex", help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="adapt", choices=["adapt"], help="Mode of operation, either 'adapt'.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "EXISTING_LECTURE_NOTES": coauthor.read_file(args.sample_tex),
            "DOCUMENT_CLS_CONTENT": coauthor.read_file(args.document_cls),
            "COMMANDS_CONTENT": coauthor.read_file(args.commands_file),
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file_path = log_start(args)

    model_settings = get_model_settings(args)
    output_settings = get_output_settings(args, task_settings)
    prompt_settings = get_prompt_settings(args, prompt_path, task_settings, args.task)

    handle_single_input(args, user_prefix_vars, prompt_settings)

    client = get_model_client(model_settings["model"])

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = process_first_round(
        client,
        args.task,
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
            args.task,
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
