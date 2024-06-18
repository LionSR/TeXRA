# coauthor/argparse_utils.py
import argparse
import os


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
        "--instruction",
        type=str,
        default=None,
        help="The specific instruction or the hints to be followed.",
    )
    parser.add_argument(
        "--reflect",
        type=bool,
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )
    parser.add_argument(
        "--figure_input",
        type=str,
        help="Path to the figure input file.",
    )
    return parser


def get_prompt_path(library, prompt_name):
    return os.path.join(
        os.path.dirname(os.path.dirname(library.__file__)), "prompts", prompt_name
    )
