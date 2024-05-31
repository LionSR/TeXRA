# coauthor/argparse_utils.py
import argparse


def get_common_argparser():
    parser = argparse.ArgumentParser(
        description="Process files with AI-assisted techniques."
    )
    parser.add_argument(
        "--input_file", type=str, help="Path to the main file to be processed."
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model name to use for processing.",
        choices=["sonnet", "opus", "haiku", "gpt4o", "gpt4turbo"],
    )
    parser.add_argument(
        "--reflect",
        type=bool,
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )
    return parser
