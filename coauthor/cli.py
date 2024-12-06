import sys
import os
import click
from dotenv import load_dotenv
from coauthor.arg_utils import comma_separated_list
from coauthor.figure_tools import (
    extract_figure_paths_from_latex,
    extract_and_compile_tikzpictures_with_labels,
)
from coauthor.tex_tools import run_latexdiff, run_latexdiff_vc, run_latexdiff_vc_multiple, get_tex_count
from coauthor.housekeeping_utils import (
    run_clean_single,
    run_pack_single,
    run_clean_build,
    run_indent_tex,
    run_clean_output,
    run_clean_multiple,
    run_pack_multiple,
    run_pack_latexdiff_vc,
    run_pack_latexdiff_vc_multiple,
)
from coauthor.logging_utils import logger


from .agent_run import run_agent, run_merge

# Add the parent directory to the system path for the windows users
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()


def shared_arguments(func):
    options = [
        # Model arguments
        click.option("--model", required=False, default="sonnet+", help="Model to use"),
        click.option("--reflect", required=False, default=None, help="Reflect on the changes"),
        click.option("--instruction", required=False, default=None, help="Instruction for processing"),
        # Input file arguments
        click.option("--input_file", required=True, help="Path to the input file"),
        click.option("--input_files", default=None, help="Path to the multiple input files"),
        # Reference file arguments
        click.option("--reference_file", default=None, help="Path to the reference file"),
        click.option("--reference_files", default=None, help="Path to the multiple reference files"),
        # Auxiliary file arguments
        click.option("--auxiliary_file", default=None, help="Path to the auxiliary file"),
        click.option("--auxiliary_files", default=None, help="Path to the multiple auxiliary files"),
        # Figure file arguments
        click.option(
            "--figure_file",
            required=False,
            default=None,
            help="Path to the figure file",
        ),
        click.option(
            "--figure_files",
            required=False,
            default=None,
            help="Path to the figure file(s). Multiple files can be specified as a comma-separated list.",
        ),
        # Output file arguments
        click.option("--output_files", type=comma_separated_list, default=None, help="Paths to the output files"),
        click.option("--output_name_override", type=str, default=None, help="Override base output name"),
        # Tool usage arguments
        click.option("--edited_file", default=None, help="Path to the file that are already edited"),
        # Auto extract figure arguments
        click.option("--auto_extract_figure", is_flag=True, help="Automatically extract the list of figures from the input file"),
        click.option("--auto_extract_tikz_figure", is_flag=True, help="Automatically extract TikZ figures from the input file"),
        click.option("--auto_extract_tikz_figure_reflect", is_flag=True, help="Include TikZ reflection in the output"),
        click.option("--include_tex_count", is_flag=True, help="Include the tex count statistics in the user message"),
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
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def merge(model, input_file, edited_file):
    """Run merge agent from CLI"""
    run_merge(model, input_file, edited_file)


@cli.command()
@shared_arguments
@click.argument("agent")
def run(agent: str, **kwargs):
    """Run any agent except merge from CLI"""
    run_agent(agent, **kwargs)


# Housekeeping operations


@cli.command()
def clean_output():
    run_clean_output()


@cli.command()
def clean_build():
    run_clean_build()


@cli.command()
def indent_tex():
    run_indent_tex()


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
def clean_single(model, input_file, agent):
    run_clean_single(model, input_file, agent)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_single(model, input_file, agent, output_name_override):
    run_pack_single(model, input_file, agent, output_name_override)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
def clean_multiple(model, input_file, input_files, agent):
    run_clean_multiple(model, input_file, input_files, agent)


@cli.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_multiple(model, input_file, input_files, agent, output_name_override):
    run_pack_multiple(model, input_file, input_files, agent, output_name_override)


@cli.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def latexdiff(input_file, edited_file):
    """Run latexdiff on the given input and edited files."""
    diff_file = run_latexdiff(input_file, edited_file)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@cli.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
def latexdiff_vc(input_file, commit_hash):
    """Run latexdiff-vc on the given input file and commit hash."""
    diff_file = run_latexdiff_vc(input_file, commit_hash)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@cli.command()
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
def latexdiff_vc_multiple(input_files, commit_hash):
    """Run latexdiff-vc on multiple input files and commit hash."""
    run_latexdiff_vc_multiple(input_files, commit_hash)


@cli.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc(input_file, commit_hash, clean):
    run_pack_latexdiff_vc(input_file, commit_hash, clean)


@cli.command()
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc_multiple(input_files, commit_hash, clean):
    run_pack_latexdiff_vc_multiple(input_files, commit_hash, clean)


@cli.command()
@click.argument("latex_file")
def tex_count(latex_file):
    stats = get_tex_count(latex_file)
    if stats is not None:
        logger.info(f"Statistics for {latex_file}:\n {stats}")


@cli.command()
@click.argument("latex_file")
def extract_figure_path(latex_file):
    figure_paths = extract_figure_paths_from_latex(latex_file)
    logger.info(f"Extracted figure file paths: {figure_paths}")


@cli.command()
@click.argument("latex_file")
def extract_tikzpictures(latex_file):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    logger.info(f"Compiled TikZ pictures: {compiled_files}")


if __name__ == "__main__":
    cli()
