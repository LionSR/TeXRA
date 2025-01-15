import sys
import os
import click
from dotenv import load_dotenv
from coauthor.latex import (
    extract_figurePaths_from_latex,
    extract_and_compile_tikzpictures_with_labels,
)
from coauthor.latex import runLatexdiff, runLatexdiffvc, runLatexdiffvc_multiple, getTexcount
from coauthor.housekeeping import (
    runCleanSingle,
    runPackSingle,
    runCleanBuild,
    runIndentTex,
    runCleanOutput,
    runCleanMultiple,
    runPackMultiple,
    runPaclLatexdiffvc,
    runPaclLatexdiffvcMultiple,
)
from coauthor.logger import logger

from coauthor.execute import runAgent, runMergeAgent

# Add the parent directory to the system path for the windows users
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()


def comma_separated_list(value):
    items = [item.strip() for item in value.split(",")]
    return [item.strip("'\"") for item in items]


def shared_arguments(func):
    options = [
        # Model arguments
        click.option("--model", required=False, default="sonnet+", help="Model to use"),
        click.option("--reflect", required=False, type=click.BOOL, default=False, help="Reflect on the changes"),
        click.option("--instruction", required=False, default=None, help="Instruction for processing"),
        # Input file arguments
        click.option("--inputFile", required=True, type=str, help="Path to the input file"),
        click.option("--inputFiles", default=None, type=comma_separated_list, help="Path to the multiple input files"),
        # Reference file arguments
        click.option("--referenceFile", default=None, type=str, help="Path to the reference file"),
        click.option("--referenceFiles", default=None, type=comma_separated_list, help="Path to the multiple reference files"),
        # Auxiliary file arguments
        click.option("--auxiliaryFile", default=None, type=str, help="Path to the auxiliary file"),
        click.option("--auxiliaryFiles", default=None, type=comma_separated_list, help="Path to the multiple auxiliary files"),
        # Figure file arguments
        click.option(
            "--figureFile",
            required=False,
            default=None,
            help="Path to the figure file",
        ),
        click.option(
            "--figureFiles",
            required=False,
            default=None,
            help="Path to the figure file(s). Multiple files can be specified as a comma-separated list.",
        ),
        # Output file arguments
        click.option("--outputFiles", default=None, type=comma_separated_list, help="Paths to the output files"),
        click.option("--outputNameOverride", type=str, default=None, help="Override base output name"),
        click.option("--editedFile", default=None, type=str, help="Path to the file that are already edited"),
        # Tool usage arguments
        click.option("--autoExtractFigure", is_flag=True, help="Automatically extract the list of figures from the input file"),
        click.option("--autoExtractTikzFigure", is_flag=True, help="Automatically extract TikZ figures from the input file"),
        click.option("--autoExtractTikzFigureReflect", is_flag=True, help="Include TikZ reflection in the output"),
        click.option("--attachTeXCount", is_flag=True, help="Include the tex count statistics in the user message"),
        click.option("--usePrefillFromInput", is_flag=True, help="Use the prefill from the input file"),
        click.option("--autoConfirmation", is_flag=True, help="Automatically confirm model's questions"),
        click.option("--printInputPrompt", is_flag=True, help="Print the input prompt to an XML file"),
        click.option("--useOpenRouter", is_flag=True, help="Use OpenRouter for model inference"),
    ]
    for option in options:
        func = option(func)
    return func


# CLI Commands
@click.group()
def cli():
    """Main CLI group for coauthor commands."""
    pass


@cli.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--editedFile", required=True, help="Path to the edited file")
def merge(model, inputFile, editedFile):
    """Run merge agent from CLI"""
    runMergeAgent(model, inputFile, editedFile)


@cli.command()
@shared_arguments
@click.argument("agent")
def run(agent: str, **kwargs):
    """Run any agent except merge from CLI"""
    print(kwargs)
    runAgent(agent, **kwargs)


# Housekeeping operations


@cli.command()
def clean_output():
    runCleanOutput()


@cli.command()
def clean_build():
    runCleanBuild()


@cli.command()
def indent_tex():
    runIndentTex()


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--inputFile", required=True, help="Path to the input file")
def clean_single(model, inputFile, agent):
    runCleanSingle(model, inputFile, agent)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--outputNameOverride", type=str, default=None, help="Override base output name")
def pack_single(model, inputFile, agent, outputNameOverride):
    runPackSingle(model, inputFile, agent, outputNameOverride)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--inputFiles", required=True, help="Paths to the input files")
def clean_multiple(model, inputFile, inputFiles, agent):
    runCleanMultiple(model, inputFile, inputFiles, agent)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--inputFiles", required=True, help="Paths to the input files")
@click.option("--outputNameOverride", type=str, default=None, help="Override base output name")
def pack_multiple(model, inputFile, inputFiles, agent, outputNameOverride):
    runPackMultiple(model, inputFile, inputFiles, agent, outputNameOverride)


@cli.command()
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--editedFile", required=True, help="Path to the edited file")
def latexdiff(inputFile, editedFile):
    """Run latexdiff on the given input and edited files."""
    diff_file = runLatexdiff(inputFile, editedFile)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@cli.command()
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--commitHash", required=True, help="Commit hash to compare against")
def latexdiff_vc(inputFile, commitHash):
    """Run latexdiff-vc on the given input file and commit hash."""
    diff_file = runLatexdiffvc(inputFile, commitHash)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@cli.command()
@click.option("--inputFiles", required=True, help="Paths to the input files")
@click.option("--commitHash", required=True, help="Commit hash to compare against")
def latexdiff_vc_multiple(inputFiles, commitHash):
    """Run latexdiff-vc on multiple input files and commit hash."""
    runLatexdiffvc_multiple(inputFiles, commitHash)


@cli.command()
@click.option("--inputFile", required=True, help="Path to the input file")
@click.option("--commitHash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc(inputFile, commitHash, clean):
    runPaclLatexdiffvc(inputFile, commitHash, clean)


@cli.command()
@click.option("--inputFiles", required=True, help="Paths to the input files")
@click.option("--commitHash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc_multiple(inputFiles, commitHash, clean):
    runPaclLatexdiffvcMultiple(inputFiles, commitHash, clean)


@cli.command()
@click.argument("latexFile")
def texcount(latexFile):
    texcountStats = getTexcount(latexFile)
    if texcountStats is not None:
        logger.info(f"Statistics for {latexFile}:\n {texcountStats}")


@cli.command()
@click.argument("latexFile")
def extract_figure_path(latexFile):
    figurePaths = extract_figurePaths_from_latex(latexFile)
    logger.info(f"Extracted figure file paths: {figurePaths}")


@cli.command()
@click.argument("latexFile")
def extract_tikzpictures(latexFile):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latexFile)
    logger.info(f"Compiled TikZ pictures: {compiled_files}")


if __name__ == "__main__":
    cli()
