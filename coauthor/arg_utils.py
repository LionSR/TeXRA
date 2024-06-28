import argparse


def comma_separated_list(value):
    items = [item.strip() for item in value.split(",")]
    return [item.strip("'\"") for item in items]


def get_common_argparser():
    parser = argparse.ArgumentParser(description="Process files with AI-assisted techniques.")
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet+",
        help="Model name to use for processing.",
        choices=["sonnet+", "opus", "sonnet", "haiku", "gpt4o", "gpt4turbo"],
    )
    parser.add_argument(
        "--reflect",
        type=lambda x: (str(x).lower() in ["true", "1", "yes"]),
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )
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
        "--auxiliary_files",
        type=comma_separated_list,
        default=[],
        help="Path to the auxiliary file(s). Multiple files can be specified.",
    )
    parser.add_argument(
        "--figure_inputs",
        type=comma_separated_list,
        default=[],
        help="Path to the figure input file(s). Multiple files can be specified.",
    )
    parser.add_argument(
        "--instruction",
        type=str,
        default=None,
        help="The specific instruction or the hints to be followed.",
    )
    parser.add_argument("--auto_extract_figure", action="store_true", help="Automatically extract figure paths from the input file")
    parser.add_argument("--include_tex_count", action="store_true", help="Include the tex count statistics in the user message")
    return parser
