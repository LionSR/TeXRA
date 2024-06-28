from termcolor import colored
import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, handle_reflection
from coauthor.prompt_utils import get_user_prefix_vars, handle_long_input, handle_single_input
from coauthor.settings_utils import (
    get_model_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files


all_tasks_settings = {
    "txt2tex": {
        "document_tag": "txt_content",
        "end_tag": "</latex_content>",
        "output_type": "tex",
        "first_prefill": "<latex_content> \\chapter",
    },
}

prompt_path = get_prompt_path(coauthor, "txt2tex")


def main():
    parser = get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="txt2tex", help="Task to perform, currently only 'txt2tex'.", choices=["txt2tex"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Converting {args.input_file} to LaTeX...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "EXISTING_LECTURE_NOTES": coauthor.read_file(args.sample_tex) if args.sample_tex else "",
            "DOCUMENT_CLS_CONTENT": coauthor.read_file(args.document_cls) if args.document_cls else "",
            "COMMANDS_CONTENT": coauthor.read_file(args.commands_file) if args.commands_file else "",
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file_path = log_start(args)

    model_settings = get_model_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)

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
