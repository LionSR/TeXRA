from termcolor import colored

import coauthor
from coauthor.arg_utils import get_common_argparser
from coauthor.file_utils import get_prompt_path
from coauthor.tex_tools import run_latexdiff
from coauthor.process import process_first_round, process_reflection_round
from coauthor.prompt_utils import get_user_prefix_vars
from coauthor.settings_utils import get_model_settings, get_output_settings, get_prompt_settings
from coauthor.model_utils import get_model_client
from coauthor.log_utils import log_start, log_and_print_statistics, log_output_files

all_tasks_settings = {
    "paper2note": {
        "document_tag": "latex_document",
        "end_tag": "</lecture_note>",
        "output_type": "tex",
        "prefill_first": "Here is the output lecture note <lecture_note>.\n\\documentclass{lecture}\n\\input{command}\n\\course",
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

    model_settings = get_model_settings(args)
    output_settings = get_output_settings(args, task_settings)
    prompt_settings = get_prompt_settings(args, prompt_path, task_settings, args.task)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = process_first_round(
        get_model_client(model_settings["model"]),
        args.task,
        args.input_file,
        user_prefix_vars,
        model_settings,
        output_settings,
        prompt_settings,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn and output_settings["output_type"] == "tex":
        run_latexdiff(args.input_file, output_file)

    log_output_files(output_file, log_file_path)
    log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = process_reflection_round(
            get_model_client(model_settings["model"]),
            args.task,
            args.input_file,
            state,
            messages,
            model_settings,
            output_settings,
            prompt_settings,
            use_prefill_from_input=False,
        )
        log_output_files(output_file_reflect, log_file_path)
        log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect and output_settings["output_type"] == "tex":
            run_latexdiff(args.input_file, output_file_reflect)
            run_latexdiff(output_file, output_file_reflect, args.model)


if __name__ == "__main__":
    main()
