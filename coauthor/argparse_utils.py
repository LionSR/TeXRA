import argparse
import os


def comma_separated_list(value):
    items = [item.strip() for item in value.split(",")]
    return [item.strip("'\"") for item in items]  # Remove surrounding quotes


def get_common_argparser():
    parser = argparse.ArgumentParser(description="Process files with AI-assisted techniques.")
    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the main file(s) to be processed. Multiple files can be specified.",
    )
    parser.add_argument(
        "--input_files",
        type=comma_separated_list,
        default=[],
        help="Path to additional input files. Multiple files can be specified.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet+",
        help="Model name to use for processing.",
        choices=["sonnet+", "opus", "sonnet", "haiku", "gpt4o", "gpt4turbo"],
    )
    parser.add_argument(
        "--instruction",
        type=str,
        default=None,
        help="The specific instruction or the hints to be followed.",
    )
    parser.add_argument(
        "--reflect",
        type=lambda x: (str(x).lower() in ["true", "1", "yes"]),
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )
    parser.add_argument(
        "--figure_inputs",
        type=comma_separated_list,
        default=[],
        help="Path to the figure input file(s). Multiple files can be specified.",
    )
    parser.add_argument(
        "--auxiliary_files",
        type=comma_separated_list,
        default=[],
        help="Path to the auxiliary file(s). Multiple files can be specified.",
    )
    return parser


def get_prompt_path(library, prompt_name):
    return os.path.join(os.path.dirname(os.path.dirname(library.__file__)), "prompts", prompt_name)


def parse_args(parser):
    args = parser.parse_args()

    # Ensure input_files is always a list
    if args.input_files is None:
        args.input_files = []
    elif not isinstance(args.input_files, list):
        args.input_files = [args.input_files]

    return args
