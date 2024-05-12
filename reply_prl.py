# reply_prl.py
import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor

# Define the settings for the "reply" mode tailored for responding to reviewer comments
all_tasks_settings = {
    "reply_prl": {
        "document_tag": "latex_document",
        "end_tag": "</reply_letter>",
        "output_type": "txt",
        "first_prefill": "<reply_letter>",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process TeX files for creating responses to reviewer comments and revising the paper."
    )
    parser.add_argument(
        "input_file",
        type=str,
        help="Path to the TeX file containing the reviewer comments.",
    )
    parser.add_argument(
        "--supp_file",
        type=str,
        help="Path to the supplementary TeX file to be included in the response.",
    )
    parser.add_argument(
        "--referee_reports",
        type=str,
        help="Path to the file containing the referee reports.",
    )
    parser.add_argument(
        "--instruction",
        type=str,
        help="Path to the file containing the overall instruction.",
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
        default="reply_prl",
        help="Mode of operation, currently only 'reply_prl'.",
        choices=["reply_prl"],
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts_reply",
        help="Path to the prompts directory.",
    )
    parser.add_argument(
        "--cover_letter",
        type=str,
        help="Path to the cover letter file.",
    )
    parser.add_argument(
        "--editor_letter",
        type=str,
        help="Path to the editor letter file.",
    )
    parser.add_argument(
        "--report_a",
        type=str,
        help="Path to the referee report A file.",
    )
    parser.add_argument(
        "--report_b",
        type=str,
        help="Path to the referee report B file.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Preparing response for {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "PREAMBLE_CONTENT": read_file("preamble.tex"),
        "MAIN_CONTENT": read_file(args.input_file),
        "SUPP_CONTENT": read_file(args.supp_file),
        "INSTRUCTION": read_file(args.instruction),
        "COVER_LETTER": read_file(args.cover_letter),
        "EDITOR_DECISION_LETTER": read_file(args.editor_letter),
        "REFEREE_REPORT_A": read_file(args.report_a),
        "REFEREE_REPORT_B": read_file(args.report_b),
    }

    task_settings = all_tasks_settings[args.task]

    # First call to process the reply letter
    coauthor.process_file_with_claude(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        model=args.model,
        prompt_path=args.prompt_path,
    )

    # Second call to process the revised paper
    # coauthor.process_file_with_claude(
    #     args.task,
    #     task_settings,
    #     args.input_file,
    #     user_prefix_input_vars,
    #     model=args.model,
    #     prompt_path=args.prompt_path,
    #     # section="revised_paper"
    # )


if __name__ == "__main__":
    main()
