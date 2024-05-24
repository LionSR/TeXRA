# txt2tex.py
import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor

all_tasks_settings = {
    "txt2tex": {
        "document_tag": "txt_content",
        "end_tag": "</latex_content>",
        "output_type": "tex",
        "first_prefill": "<latex_content>\chapter",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Convert a text file generated from a PDF into LaTeX format."
    )
    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the text file generated from the PDF.",
    )
    parser.add_argument(
        "--sample_tex",
        type=str,
        help="Path to a sample LaTeX file in the desired style.",
    )
    parser.add_argument(
        "--document_cls",
        type=str,
        help="Path to the document class file.",
    )
    parser.add_argument(
        "--commands_file",
        type=str,
        help="Path to the file containing custom LaTeX commands.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model name to use for processing.",
        choices=["sonnet", "opus", "haiku", "gpt4o", "gpt4turbo"],
    )
    parser.add_argument(
        "--task",
        type=str,
        default="txt2tex",
        help="Task to perform, currently only 'txt2tex'.",
        choices=["txt2tex"],
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
        default="prompts/txt2tex",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Converting {args.input_file} to LaTeX...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "SAMPLE_TEX": read_file(args.sample_tex) if args.sample_tex else "",
        "DOCUMENT_CLS_CONTENT": read_file(args.document_cls) if args.document_cls else "",
        "COMMANDS_CONTENT": read_file(args.commands_file) if args.commands_file else "",
    }

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_claude(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        model=args.model,
        prompt_path=args.prompt_path,
        reflect=args.reflect,
        use_prefill_from_input=False,
    )


if __name__ == "__main__":
    main()