import argparse


def comma_separated_list(value):
    items = [item.strip() for item in value.split(",")]
    return [item.strip("'\"") for item in items]


def add_common_arguments(parser):
    """Add common arguments to the argument parser.

    Groups related arguments together for better organization.
    """
    # Model arguments
    parser.add_argument("--agent", type=str, default="merge", help="Agent to choose.")
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet+",
        help="Model name to use for processing.",
    )
    parser.add_argument(
        "--reflect",
        type=lambda x: (str(x).lower() in ["true", "1", "yes"]),
        default=False,
        help="Whether to perform a reflection round after the initial processing.",
    )

    # Input file arguments
    input_group = parser.add_argument_group("Input Files")
    input_group.add_argument(
        "--input_file",
        type=str,
        default=None,
        help="Path to input file.",
    )
    input_group.add_argument(
        "--input_files",
        type=comma_separated_list,
        default=[],
        help="Path to input files. Multiple files can be specified.",
    )

    # Reference file arguments
    reference_group = parser.add_argument_group("Reference Files")
    reference_group.add_argument(
        "--reference_file",
        type=str,
        default=None,
        help="Path to the reference file.",
    )
    reference_group.add_argument(
        "--reference_files",
        type=comma_separated_list,
        default=[],
        help="Path to the reference file(s). Multiple files can be specified.",
    )

    # Auxiliary file arguments
    auxiliary_group = parser.add_argument_group("Auxiliary Files")
    auxiliary_group.add_argument(
        "--auxiliary_file",
        type=str,
        default=None,
        help="Path to the auxiliary file.",
    )
    auxiliary_group.add_argument(
        "--auxiliary_files",
        type=comma_separated_list,
        default=[],
        help="Path to the auxiliary file(s). Multiple files can be specified.",
    )

    # Figure input arguments
    figure_group = parser.add_argument_group("Figure Files")
    figure_group.add_argument(
        "--figure_file",
        type=str,
        default=None,
        help="Path to the figure file.",
    )
    figure_group.add_argument(
        "--figure_files",
        type=comma_separated_list,
        default=[],
        help="Path to the figure file(s). Multiple files can be specified.",
    )

    # Tool usage arguments
    tool_group = parser.add_argument_group("Tool Usage")
    tool_group.add_argument("--use_prefill_from_input", action="store_true", help="Use the prefill from the input file")
    tool_group.add_argument("--auto_extract_figure", action="store_true", help="Automatically extract the list of figures from the input file")
    tool_group.add_argument(
        "--auto_extract_tikz_figure", action="store_true", help="Automatically extract TikZ the list of figures from the input file"
    )
    tool_group.add_argument("--auto_extract_tikz_figure_reflect", action="store_true", help="Include TikZ reflection in the output")
    tool_group.add_argument("--include_tex_count", action="store_true", help="Include the tex count statistics in the user message")

    # Other arguments
    parser.add_argument("--edited_file", type=str, help="Path to the file that are already edited")
    parser.add_argument("--instruction", type=str, default=None, help="The specific instruction or hints to be followed")
    parser.add_argument("--output_files", type=comma_separated_list, default=None, help="Paths to the output files")
    parser.add_argument("--output_name_override", type=str, default=None, help="Override base output name")

    return parser


def get_common_argparser():
    parser = argparse.ArgumentParser(description="Process files with AI-assisted techniques.")
    add_common_arguments(parser)
    return parser
