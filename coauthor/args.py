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
        "--inputFile",
        type=str,
        default=None,
        help="Path to input file.",
    )
    input_group.add_argument(
        "--inputFiles",
        type=comma_separated_list,
        default=[],
        help="Path to input files. Multiple files can be specified.",
    )

    # Reference file arguments
    reference_group = parser.add_argument_group("Reference Files")
    reference_group.add_argument(
        "--referenceFile",
        type=str,
        default=None,
        help="Path to the reference file.",
    )
    reference_group.add_argument(
        "--referenceFiles",
        type=comma_separated_list,
        default=[],
        help="Path to the reference file(s). Multiple files can be specified.",
    )

    # Auxiliary file arguments
    auxiliary_group = parser.add_argument_group("Auxiliary Files")
    auxiliary_group.add_argument(
        "--auxiliaryFile",
        type=str,
        default=None,
        help="Path to the auxiliary file.",
    )
    auxiliary_group.add_argument(
        "--auxiliaryFiles",
        type=comma_separated_list,
        default=[],
        help="Path to the auxiliary file(s). Multiple files can be specified.",
    )

    # Figure input arguments
    figure_group = parser.add_argument_group("Figure Files")
    figure_group.add_argument(
        "--figureFile",
        type=str,
        default=None,
        help="Path to the figure file.",
    )
    figure_group.add_argument(
        "--figureFiles",
        type=comma_separated_list,
        default=[],
        help="Path to the figure file(s). Multiple files can be specified.",
    )

    # Tool usage arguments
    tool_group = parser.add_argument_group("Tool Usage")
    tool_group.add_argument("--usePrefillFromInput", action="store_true", help="Use the prefill from the input file")
    tool_group.add_argument("--autoExtractFigure", action="store_true", help="Automatically extract the list of figures from the input file")
    tool_group.add_argument("--autoExtractTikzFigure", action="store_true", help="Automatically extract TikZ the list of figures from the input file")
    tool_group.add_argument("--autoExtractTikzFigureReflect", action="store_true", help="Include TikZ reflection in the output")
    tool_group.add_argument("--includeTexCount", action="store_true", help="Include the tex count statistics in the user message")
    tool_group.add_argument("--autoConfirmation", action="store_true", help="Automatically confirm model's questions")
    tool_group.add_argument("--printInputPrompt", action="store_true", help="Print the input prompt to an XML file")
    tool_group.add_argument("--useOpenrouter", action="store_true", help="Use OpenRouter for model inference")

    # Other arguments
    parser.add_argument("--editedFile", type=str, help="Path to the file that are already edited")
    parser.add_argument("--instruction", type=str, default=None, help="The specific instruction or hints to be followed")
    parser.add_argument("--outputFiles", type=comma_separated_list, default=None, help="Paths to the output files")
    parser.add_argument("--outputNameOverride", type=str, default=None, help="Override base output name")

    return parser


def get_common_argparser():
    parser = argparse.ArgumentParser(description="Process files with AI-assisted techniques.")
    add_common_arguments(parser)
    return parser
