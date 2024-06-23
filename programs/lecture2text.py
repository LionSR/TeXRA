import os
from termcolor import colored
import coauthor
from coauthor import (
    read_file,
    extract_text_from_tags,
    get_common_argparser,
    get_prompt_path,
)

# Define the settings for each mode
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

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "DOCUMENT_CLS": "lecture.cls",
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        "COMMANDS": "commands_qi.tex",
        "COMMANDS_CONTENT": read_file("commands_qi.tex"),
    }

    if args.task in ["2tex", "reflect"]:
        user_prefix_vars["INPUT_CONTENT"] = extract_text_from_tags(read_file(args.input_file), "improved_document")
    elif args.task in ["transcribe", "punctuate"]:
        user_prefix_vars["INPUT_CONTENT"] = read_file(args.input_file)

    # Get the settings for the selected mode
    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        reflect=args.reflect,
        model=args.model,
        prompt_path=prompt_path,
    )


if __name__ == "__main__":
    main()
