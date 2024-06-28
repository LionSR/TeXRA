from termcolor import colored
import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, handle_reflection
from coauthor.prompt_utils import get_user_prefix_vars
from coauthor.settings_utils import (
    get_model_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files


all_tasks_settings = {
    "transcribe": {
        "document_tag": "edited_transcript",
        "end_tag": "</edited_transcript>",
        "output_type": "md",
        "prefill_first": "Here is the faithfully and correctly edited transcript:\n<edited_transcript>",
    },
}

prompt_path = get_prompt_path(coauthor, "meeting2text")


def main():
    parser = get_common_argparser()
    parser.add_argument("--context_file", type=str, required=True, help="Path to the file containing the context for the discussion transcript.")
    parser.add_argument("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
    parser.add_argument("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
    parser.add_argument("--task", type=str, default="transcribe", help="Task to perform, currently only 'transcribe'.", choices=["transcribe"])
    parser.add_argument("--append_mode", type=bool, default=True, help="Whether to append the output to the input file instead of overwriting it.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "TRANSCRIPT": coauthor.read_file(args.input_file),
            "CONTEXT": coauthor.read_file(args.context_file),
            "EXAMPLE_TRANSCRIPT": coauthor.read_file(args.example_transcript) if args.example_transcript else "",
            "EXAMPLE_EDITED_TRANSCRIPT": coauthor.read_file(args.example_edited_transcript) if args.example_edited_transcript else "",
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file_path = log_start(args)

    model_settings = get_model_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)
    output_settings["append_mode"] = args.append_mode

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_first_round(
        args.task, task_settings, args.input_file, user_prefix_vars, model_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    run_latexdiff(args.input_file, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
