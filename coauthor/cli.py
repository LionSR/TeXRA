import sys
import os
import click
import shlex
import subprocess

from dotenv import load_dotenv
from pathlib import Path

from coauthor.arg_utils import comma_separated_list
from coauthor.figure_tools import (
    extract_figure_paths,
    extract_and_compile_tikzpictures_with_labels,
    handle_auto_extract_figure,
    handle_auto_extract_tikz_figure,
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
from coauthor.file_utils import get_agent_dir_from_env
from coauthor.logging_utils import logger

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
        click.option("--auto_extract_tikz_figure", is_flag=True, help="Automatically extract TikZ the list of figures from the input file"),
        click.option("--auto_extract_tikz_figure_reflect", is_flag=True, help="Include TikZ reflection in the output"),
        click.option("--include_tex_count", is_flag=True, help="Include the tex count statistics in the user message"),
    ]
    for option in options:
        func = option(func)
    return func


def execute_agent(script, agent, **kwargs):
    agents_dir = get_agent_dir_from_env()

    # Check if multiple agent exists and output_files is specified
    multiple_agent = f"{agent}_multiple"
    multiple_yaml_exists = any((Path(agents_dir) / script).rglob(f"{multiple_agent}.yaml"))

    # Use multiple agent only if both conditions are met
    if kwargs.get("output_files") and multiple_yaml_exists:
        agent = multiple_agent

    command = [
        "python",
        f"{agents_dir}/{script}.py",
        f"--agent={agent}",
    ]
    if kwargs.get("model"):
        command.append(f"--model={kwargs.get('model')}")
    if kwargs.get("input_file"):
        command.append(f"--input_file={kwargs.get('input_file')}")

    # Handle figure files - merge figure_file into figure_files if either exists
    # may to use all_figure_files
    figure_files = []
    if kwargs.get("figure_file"):
        figure_files.append(kwargs.get("figure_file"))
    if kwargs.get("figure_files"):
        if isinstance(kwargs["figure_files"], str):
            figure_files.extend(kwargs["figure_files"].split(","))
        elif isinstance(kwargs["figure_files"], list):
            figure_files.extend(kwargs["figure_files"])
        kwargs["figure_files"] = figure_files

    # this auto extract figure logic should be handled in the agent script
    if kwargs.get("auto_extract_figure"):
        handle_auto_extract_figure(kwargs, kwargs.get("input_file"))

    # Prepare all input files
    all_input_files = [kwargs.get("input_file")]
    if kwargs.get("input_files"):
        if isinstance(kwargs["input_files"], str):
            all_input_files.extend(kwargs["input_files"].split(","))

    # here only tikz figure are extracted from all the input files but not the normal figure
    # this auto extract tikz figure logic should be handled in the agent script
    if kwargs.get("auto_extract_tikz_figure"):
        handle_auto_extract_tikz_figure(kwargs, all_input_files)

    for key, value in kwargs.items():
        if value is not None:
            if isinstance(value, bool):
                if value:
                    command.append(f"--{key}")
            elif key in ["input_files", "reference_files", "auxiliary_files", "figure_files", "output_files"]:
                if isinstance(value, str):
                    value = [value]
                # Convert all elements to strings before joining
                command.append(f"--{key}")
                command.append(",".join(map(str, value)))  # Join the list into a single comma-separated string
            else:
                command.append(f"--{key}")
                command.append(shlex.quote(str(value)).strip("'"))

    subprocess.run(command)


@click.group()
def cli():
    """Main CLI group for coauthor commands."""
    pass


@cli.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def merge(model, input_file, edited_file):
    agents_dir = get_agent_dir_from_env()
    command = [
        "python",
        f"{agents_dir}/merge.py",
        f"--input_file={input_file}",
        f"--edited_file={edited_file}",
        f"--model={model}",
    ]
    subprocess.run(command)


# Agents


@cli.command()
@shared_arguments
@click.argument("agent")
def run(agent: str, **kwargs):
    """Run any agent except merge using execute_agent"""
    execute_agent("run", agent, **kwargs)


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
    figure_paths = extract_figure_paths(latex_file)
    logger.info(f"Extracted figure file paths: {figure_paths}")


@cli.command()
@click.argument("latex_file")
def extract_tikzpictures(latex_file):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    logger.info(f"Compiled TikZ pictures: {compiled_files}")


if __name__ == "__main__":
    cli()
