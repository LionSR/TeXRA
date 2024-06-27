from termcolor import colored

import coauthor
from coauthor import get_common_argparser, get_prompt_path
from coauthor.process import process_file_with_llm
from coauthor.edit_utils import (
    get_user_prefix_vars,
    handle_long_task,
    handle_reflection,
    get_llm_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_summary, log_output_files


all_tasks_settings = {
    "paper2note": {
        "document_tag": "latex_document",
        "end_tag": "</lecture_note>",
        "output_type": "tex",
        "first_prefill": "Here is the output lecture note <lecture_note>.\n\\documentclass{lecture}\n\\input{command}\n\\course",
    },
}

prompt_path = get_prompt_path(coauthor, "paper2note")


def main():
    parser = get_common_argparser()
    parser.add_argument("--sample_chapters", type=str, nargs="+", help="Paths to the sample chapter TeX files.")
    parser.add_argument("--sample_paper", type=str, help="Path to the sample research paper TeX file.")
    parser.add_argument("--sample_note", type=str, help="Path to the sample lecture note TeX file corresponding to the sample paper.")
    parser.add_argument("--task", type=str, default="paper2note", help="Task to perform, currently only 'paper2note'.", choices=["paper2note"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Preparing lecture notes for {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "SAMPLE_CHAPTERS": "\n".join([coauthor.read_file(ch) for ch in args.sample_chapters]),
            "SAMPLE_PAPER": coauthor.read_file(args.sample_paper),
            "SAMPLE_NOTE": coauthor.read_file(args.sample_note),
            "DOCUMENT_CLS_CONTENT": coauthor.read_file("lecture.cls"),
            "COMMANDS_CONTENT": coauthor.read_file("command.tex"),
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file_path = log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_file_with_llm(
        args.task, task_settings, args.input_file, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    coauthor.run_latexdiff(args.input_file, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_summary(state, args.model, log_file_path)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
