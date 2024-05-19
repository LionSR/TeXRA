# prl_reply.py
import os
import argparse
from termcolor import colored

from coauthor import read_file
import coauthor

all_tasks_settings = {
    "reply_letter": {
        "document_tag": "latex_document",
        "end_tag": "</reply_letter>",
        "output_type": "txt",
        # "first_prefill": "<scratchpad>",
        "first_prefill": "<reply_letter>\n<cover_letter>",
    },
    "revise_main": {
        "document_tag": "latex_document",
        "end_tag": "</revised_main>",
        "output_type": "tex",
        "first_prefill": "Now output the revised main paper.\n <revised_main>",
    },
    "revise_supp": {
        "document_tag": "latex_document",
        "end_tag": "</revise_supp>",
        "output_type": "tex",
        "first_prefill": "Now output the revised supplementary material.\n <revise_supp>",
    },
    "polish_reply": {
        "document_tag": "latex_document",
        "end_tag": "</reply_letter>",
        "output_type": "txt",
        "first_prefill": "Now output the polished reply letter.\n <reply_letter>",
    },
}


def main():
    parser = argparse.ArgumentParser(
        description="Process TeX files for creating responses to reviewer comments and revising the paper."
    )
    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the TeX file to be considered the input.",
    )
    parser.add_argument(
        "--main_content",
        type=str,
        help="Path to the main content TeX file to be included in the response.",
        default=None,
    )
    parser.add_argument(
        "--supp_file",
        type=str,
        help="Path to the supplementary TeX file to be included in the response.",
        default=None,
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
        choices=["sonnet", "opus", "haiku", "gpt4o", "gpt4turbo"],
    )
    parser.add_argument(
        "--task",
        type=str,
        default="reply_letter",
        help="Mode of operation, currently only 'prl_reply' and 'revise_paper'.",
        choices=["reply_letter", "revise_main", "revise_supp", "polish_reply"],
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
    parser.add_argument(
        "--preamble",
        type=str,
        default="preamble.tex",
        help="Path to the preamble file.",
    )
    parser.add_argument(
        "--example_reply_letter",
        type=str,
        default="rebuttal_example/reply_letter.txt",
        help="Path to the example reply letter file.",
    )
    parser.add_argument(
        "--draft_reply_letter",
        type=str,
        help="Path to the draft reply letter file.",
        # default=None,
    )
    parser.add_argument(
        "--draft_main_content",
        type=str,
        help="Path to the draft main content file.",
        # default=None,
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Preparing response for {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "PREAMBLE_CONTENT": read_file(args.preamble),
        "MAIN_CONTENT": read_file(args.input_file),
        "SUPP_CONTENT": read_file(args.supp_file),
        "INSTRUCTION": read_file(args.instruction),
        "COVER_LETTER": read_file(args.cover_letter),
        "EDITOR_DECISION_LETTER": read_file(args.editor_letter),
        "REFEREE_REPORT_A": read_file(args.report_a),
        "REFEREE_REPORT_B": read_file(args.report_b),
        "EXAMPLE_REPLY_LETTER": read_file(args.example_reply_letter),
    }

    task_settings = all_tasks_settings[args.task]

    if "revise" or "polish" in args.task:
        user_prefix_input_vars["DRAFT_REPLY_LETTER"] = read_file(
            args.draft_reply_letter
        )

    if "polish" in args.task:
        user_prefix_input_vars["MAIN_CONTENT"] = read_file(args.main_content)

    if args.task == "revise_supp":
        user_prefix_input_vars["SUPP_CONTENT"] = (read_file(args.input_file),)
        user_prefix_input_vars["MAIN_CONTENT"] = read_file(args.main_content)
        user_prefix_input_vars["DRAFT_MAIN_CONTENT"] = read_file(
            args.draft_main_content
        )

    # First call to process the reply letter
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
