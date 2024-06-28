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
    "correct_prl": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "Now we output the corrected supp.tex as follows.\n<latex_document>",
    },
    "correct_supp_prl": {
        "document_tag": "latex_document",
        "output_type": "tex",
        "end_tag": "</latex_document>",
        "prefill_first": "Now we output the corrected supp.tex as follows.\n<latex_document>",
    },
}

prompt_path = get_prompt_path(coauthor, "prl_edit")


def main():
    parser = get_common_argparser()
    parser.add_argument("--auxiliary_files", type=str, help="Path to the auxiliary TeX file to be processed.")
    parser.add_argument(
        "--task",
        type=str,
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars["PREAMBLE_CONTENT"] = coauthor.read_file("preamble.tex")

    if args.task == "correct_prl":
        user_prefix_vars["SUPP_CONTENT"] = coauthor.read_file("supp.tex")
    elif args.task == "correct_supp_prl":
        user_prefix_vars["main_content"] = coauthor.read_file(args.auxiliary_files)

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
