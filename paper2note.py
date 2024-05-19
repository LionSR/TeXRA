import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor

all_tasks_settings = {
    "paper2note": {
        "document_tag": "latex_document",
        "end_tag": "</lecture_note>",
        "output_type": "tex",
        "first_prefill": "<lecture_note>\n",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process a research paper to generate lecture notes."
    )
    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the research paper TeX file.",
    )
    parser.add_argument(
        "--sample_chapters",
        type=str,
        nargs="+",
        help="Paths to the sample chapter TeX files.",
    )
    parser.add_argument(
        "--sample_paper",
        type=str,
        help="Path to the sample research paper TeX file.",
    )
    parser.add_argument(
        "--sample_note",
        type=str,
        help="Path to the sample lecture note TeX file corresponding to the sample paper.",
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
        default="paper2note",
        help="Task to perform, currently only 'paper2note'.",
        choices=["paper2note"],
    )
    parser.add_argument(
        "--reflect",
        type=bool,
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts/paper2note",
        help="Path to the prompts directory.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Preparing lecture notes for {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "SAMPLE_CHAPTERS": "\n".join([read_file(ch) for ch in args.sample_chapters]),
        "SAMPLE_PAPER": read_file(args.sample_paper),
        "SAMPLE_NOTE": read_file(args.sample_note),
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        "COMMANDS_CONTENT": read_file("command.tex"),
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
    )


if __name__ == "__main__":
    main()
