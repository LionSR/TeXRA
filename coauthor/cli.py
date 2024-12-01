import sys
import os
import click
import shlex
import subprocess
from dotenv import load_dotenv

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
        click.option("--model", required=False, default="sonnet+", help="Model to use"),
        click.option("--reflect", required=False, default=None, help="Reflect on the changes"),
        click.option("--instruction", required=False, default=None, help="Instruction for processing"),
        click.option("--input_file", required=True, help="Path to the input file"),
        click.option("--input_files", default=None, help="Path to the multiple input files"),
        click.option("--reference_file", default=None, help="Path to the reference file"),
        click.option("--reference_files", default=None, help="Path to the multiple reference files"),
        click.option("--auxiliary_file", default=None, help="Path to the auxiliary file"),
        click.option("--auxiliary_files", default=None, help="Path to the multiple auxiliary files"),
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
        click.option("--edited_file", default=None, help="Path to the file that are already edited"),
        click.option("--auto_extract_figure", is_flag=True, help="Automatically extract the list of figures from the input file"),
        click.option("--auto_extract_tikz_figure", is_flag=True, help="Automatically extract TikZ the list of figures from the input file"),
        click.option("--auto_extract_tikz_figure_reflect", is_flag=True, help="Include TikZ reflection in the output"),
        click.option("--include_tex_count", is_flag=True, help="Include the tex count statistics in the user message"),
        click.option("--output_files", type=comma_separated_list, default=None, help="Paths to the output files"),
        click.option("--output_name_override", type=str, default=None, help="Override base output name"),
    ]
    for option in options:
        func = option(func)
    return func


def execute_agent(script, agent, model, input_file, **kwargs):
    agents_dir = get_agent_dir_from_env()
    command = [
        "python",
        f"{agents_dir}/{script}.py",
        f"--agent={agent}",
        f"--model={model}",
        f"--input_file={input_file}",
    ]

    # Handle figure files - merge figure_file into figure_files if either exists
    figure_files = []
    if kwargs.get("figure_file"):
        figure_files.append(kwargs.get("figure_file"))
    if kwargs.get("figure_files"):
        if isinstance(kwargs["figure_files"], str):
            figure_files.extend(kwargs["figure_files"].split(","))
        elif isinstance(kwargs["figure_files"], list):
            figure_files.extend(kwargs["figure_files"])
        kwargs["figure_files"] = figure_files

    if kwargs.get("auto_extract_figure"):
        handle_auto_extract_figure(kwargs, input_file)

    # Prepare all input files
    all_input_files = [input_file]
    if kwargs.get("input_files"):
        if isinstance(kwargs["input_files"], str):
            all_input_files.extend(kwargs["input_files"].split(","))

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


@click.command()
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


@click.command()
@shared_arguments
def correct_tex(model, input_file, **kwargs):
    agent = "correct_tex"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"

    execute_agent("article", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_tex(model, input_file, **kwargs):
    agent = "polish_tex"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("article", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_tex(model, input_file, **kwargs):
    agent = "draw_tex"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("article", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def adapt_note(model, input_file, **kwargs):
    execute_agent("lecture", "adapt_note", model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_qi(model, input_file, **kwargs):
    execute_agent("lecture", "correct_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_st(model, input_file, **kwargs):
    execute_agent("lecture", "correct_st", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_st(model, input_file, **kwargs):
    agent = "polish_st"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_qi(model, input_file, **kwargs):
    agent = "polish_qi"
    execute_agent("lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_st(model, input_file, **kwargs):
    agent = "revise_st"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_st(model, input_file, **kwargs):
    agent = "draw_st"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_qi(model, input_file, **kwargs):
    execute_agent("lecture", "draw_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
def meeting2text(model, input_file, **kwargs):
    execute_agent("meeting2text", "transcribe_dual", model, input_file, **kwargs)


@click.command()
@shared_arguments
def txt2tex(model, input_file, **kwargs):
    execute_agent("txt2tex", "txt2tex", model, input_file, **kwargs)


@click.command()
@shared_arguments
def txt2tex_article(model, input_file, **kwargs):
    execute_agent("txt2tex", "txt2tex_article", model, input_file, **kwargs)


@click.command()
@shared_arguments
def txt2tex_paper(model, input_file, **kwargs):
    execute_agent("txt2tex", "txt2tex_paper", model, input_file, **kwargs)


@click.command()
@shared_arguments
def txt2tex_example(model, input_file, **kwargs):
    execute_agent("txt2tex", "txt2tex_example", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2note(model, input_file, **kwargs):
    execute_agent("paper2note", "paper2note", model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_prl(model, input_file, **kwargs):
    execute_agent("edit_prl", "correct_prl", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_prl(model, input_file, **kwargs):
    execute_agent("edit_prl", "polish_prl", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_cover(model, input_file, **kwargs):
    execute_agent("write", "polish_cover", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2cover(model, input_file, **kwargs):
    execute_agent("write", "paper2cover", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2poster(model, input_file, **kwargs):
    execute_agent("write", "paper2poster", model, input_file, **kwargs)


@click.command()
@shared_arguments
def write_proposal(model, input_file, **kwargs):
    execute_agent("write", "write_proposal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def slide2paper(model, input_file, **kwargs):
    execute_agent("write", "slide2paper", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2slide(model, input_file, **kwargs):
    execute_agent("write", "paper2slide", model, input_file, **kwargs)


@click.command()
@shared_arguments
def statement_diversity(model, input_file, **kwargs):
    execute_agent("statement", "statement_diversity", model, input_file, **kwargs)


@click.command()
@shared_arguments
def statement_research(model, input_file, **kwargs):
    execute_agent("statement", "statement_research", model, input_file, **kwargs)


@click.command()
@shared_arguments
def statement_teaching(model, input_file, **kwargs):
    execute_agent("statement", "statement_teaching", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_nsf_grant(model, input_file, **kwargs):
    execute_agent("grant", "revise_nsf_grant", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_marie_curie(model, input_file, **kwargs):
    execute_agent("grant", "revise_marie_curie", model, input_file, **kwargs)


@click.command()
@shared_arguments
def text2tex(model, input_file, **kwargs):
    execute_agent("meeting2text", "text2tex", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_prl(model, input_file, **kwargs):
    execute_agent(
        "rebuttal_prl",
        "revise_prl",
        model,
        input_file,
        **kwargs,
    )


@click.command()
@shared_arguments
def draft_rebuttal_prl(model, input_file, **kwargs):
    execute_agent("rebuttal_prl", "draft_rebuttal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_rebuttal_prl(model, input_file, **kwargs):
    execute_agent("rebuttal_prl", "revise_rebuttal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2referee(model, input_file, **kwargs):
    execute_agent("write", "paper2referee", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_referee(model, input_file, **kwargs):
    execute_agent("write", "revise_referee", model, input_file, **kwargs)


@click.command()
@shared_arguments
def translate2chn(model, input_file, **kwargs):
    execute_agent("write", "translate2chn", model, input_file, **kwargs)


@click.command()
@shared_arguments
def convert_tex(model, input_file, **kwargs):
    agent = "convert"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    execute_agent("article", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def ocr_tex(model, input_file, **kwargs):
    execute_agent("article", "ocr", model, input_file, **kwargs)


# Housekeeping operations


@click.command()
def clean_output():
    run_clean_output()


@click.command()
def clean_build():
    run_clean_build()


@click.command()
def indent_tex():
    run_indent_tex()


@click.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
def clean_single(model, input_file, agent):
    run_clean_single(model, input_file, agent)


@click.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_single(model, input_file, agent, output_name_override):
    run_pack_single(model, input_file, agent, output_name_override)


@click.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
def clean_multiple(model, input_file, input_files, agent):
    run_clean_multiple(model, input_file, input_files, agent)


@click.command()
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_multiple(model, input_file, input_files, agent, output_name_override):
    run_pack_multiple(model, input_file, input_files, agent, output_name_override)


@click.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def latexdiff(input_file, edited_file):
    """Run latexdiff on the given input and edited files."""
    diff_file = run_latexdiff(input_file, edited_file)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@click.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
def latexdiff_vc(input_file, commit_hash):
    """Run latexdiff-vc on the given input file and commit hash."""
    diff_file = run_latexdiff_vc(input_file, commit_hash)
    if diff_file is None:
        logger.error("Failed to generate diff file")


@click.command()
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
def latexdiff_vc_multiple(input_files, commit_hash):
    """Run latexdiff-vc on multiple input files and commit hash."""
    run_latexdiff_vc_multiple(input_files, commit_hash)


@click.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc(input_file, commit_hash, clean):
    run_pack_latexdiff_vc(input_file, commit_hash, clean)


@click.command()
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc_multiple(input_files, commit_hash, clean):
    run_pack_latexdiff_vc_multiple(input_files, commit_hash, clean)


@click.command()
@click.argument("latex_file")
def tex_count(latex_file):
    stats = get_tex_count(latex_file)
    if stats is not None:
        logger.info(f"Statistics for {latex_file}:\n {stats}")


@click.command()
@click.argument("latex_file")
def extract_figure_path(latex_file):
    figure_paths = extract_figure_paths(latex_file)
    logger.info(f"Extracted figure file paths: {figure_paths}")


@click.command()
@click.argument("latex_file")
def extract_tikzpictures(latex_file):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    logger.info(f"Compiled TikZ pictures: {compiled_files}")


if __name__ == "__main__":
    cli()


# merge
cli.add_command(merge)

# article.py
cli.add_command(correct_tex)
cli.add_command(polish_tex)
cli.add_command(draw_tex)
cli.add_command(convert_tex)
cli.add_command(ocr_tex)

# lecture.py
cli.add_command(adapt_note)
cli.add_command(correct_st)
cli.add_command(correct_qi)
cli.add_command(polish_st)
cli.add_command(polish_qi)
cli.add_command(revise_st)
cli.add_command(draw_st)
cli.add_command(draw_qi)

# meeting2text.py
cli.add_command(meeting2text)
cli.add_command(text2tex)

# txt2tex.py
cli.add_command(txt2tex)
cli.add_command(txt2tex_article)
cli.add_command(txt2tex_paper)
cli.add_command(txt2tex_example)

# paper2note.py
cli.add_command(paper2note)

# edit_prl.py
cli.add_command(correct_prl)
cli.add_command(polish_prl)
cli.add_command(revise_prl)

# reply_prl.py
cli.add_command(draft_rebuttal_prl)
cli.add_command(revise_rebuttal_prl)

# write_tex.py
cli.add_command(polish_cover)
cli.add_command(paper2cover)
cli.add_command(write_proposal)
cli.add_command(slide2paper)
cli.add_command(paper2slide)
cli.add_command(paper2referee)
cli.add_command(revise_referee)
cli.add_command(paper2poster)
cli.add_command(translate2chn)

# application.py
cli.add_command(statement_diversity)
cli.add_command(statement_research)
cli.add_command(statement_teaching)

# grant.py
cli.add_command(revise_nsf_grant)
cli.add_command(revise_marie_curie)

# Housekeepings

# clean up
cli.add_command(clean_output)
cli.add_command(clean_build)
cli.add_command(clean_single)
cli.add_command(clean_multiple)

# pack
cli.add_command(pack_single)
cli.add_command(pack_multiple)

# latexindent
cli.add_command(indent_tex)

# latexdiff
cli.add_command(latexdiff)
cli.add_command(latexdiff_vc)
cli.add_command(latexdiff_vc_multiple)
cli.add_command(pack_latexdiff_vc)
cli.add_command(pack_latexdiff_vc_multiple)

# tools
cli.add_command(tex_count)
cli.add_command(extract_figure_path)
cli.add_command(extract_tikzpictures)


if __name__ == "__main__":
    cli()
