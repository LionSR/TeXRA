import os
from termcolor import colored
import coauthor
from coauthor import get_common_argparser, get_prompt_path, extract_text_from_tags
from coauthor.process import process_file_with_llm
from coauthor.edit_utils import (
    get_user_prefix_vars,
    log_start,
    log_summary,
    handle_reflection,
    get_llm_settings,
    get_output_settings,
)

all_tasks_settings = {
    "transcribe": {
        "document_tag": "improved_document",
        "end_tag": "</improved_document>",
        "output_type": "txt",
        "first_prefill": "Here is the faithfully and correctly improved document:\n<improved_document>",
    },
    "punctuate": {
        "document_tag": "improved_document",
        "end_tag": "</improved_document>",
        "output_type": "txt",
        "first_prefill": "Here is the faithfully and correctly improved document:\n<improved_document>",
    },
    "2tex": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "\\documentclass{lecture}\n\\input{commands_qi}\n\\course{",
    },
    "reflect": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "first_prefill": "\\documentclass{lecture}\n\\input{commands_qi}",
    },
}

prompt_path = get_prompt_path(coauthor, "lecture2text")


def main():
    parser = get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "DOCUMENT_CLS": "lecture.cls",
            "DOCUMENT_CLS_CONTENT": coauthor.read_file("lecture.cls"),
            "COMMANDS": "commands_qi.tex",
            "COMMANDS_CONTENT": coauthor.read_file("commands_qi.tex"),
        }
    )

    if args.task in ["2tex", "reflect"]:
        user_prefix_vars["INPUT_CONTENT"] = extract_text_from_tags(coauthor.read_file(args.input_file), "improved_document")
    elif args.task in ["transcribe", "punctuate"]:
        user_prefix_vars["INPUT_CONTENT"] = coauthor.read_file(args.input_file)

    task_settings = all_tasks_settings[args.task]

    log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_file_with_llm(
        args.task, task_settings, args.input_file, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    coauthor.run_latexdiff(args.input_file, output_file)

    log_summary(args, state)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
