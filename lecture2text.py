import argparse
from termcolor import colored

from coauthor import read_file, extract_text_from_tags
import coauthor

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


def main():
    parser = argparse.ArgumentParser(description="AI-assisted transcription.")
    parser.add_argument(
        "--input_file", type=str, help="Path to the INPUT file to be processed."
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model name to use for processing.",
        choices=["sonnet", "opus", "haiku"],
    )
    parser.add_argument(
        "--task",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    parser.add_argument(
        "--reflect",
        type=bool,
        default=True,
        help="Whether to perform a reflection round after the initial processing.",
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts/transcribe",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": args.input_file,
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        "COMMANDS_QI_CONTENT": read_file("commands_qi.tex"),
    }

    if args.task in ["2tex", "reflect"]:
        user_prefix_input_vars["INPUT_CONTENT"] = extract_text_from_tags(
            read_file(args.input_file), "improved_document"
        )
    elif args.task in ["transcribe", "punctuate"]:
        user_prefix_input_vars["INPUT_CONTENT"] = read_file(args.input_file)

    # Get the settings for the selected mode
    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_claude(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        reflect=args.reflect,
        model=args.model,
        prompt_path=args.prompt_path,
    )


if __name__ == "__main__":
    main()
