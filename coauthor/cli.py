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

# Add the parent directory to the system path for the windows users
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

load_dotenv()


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "sonnet+")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/agents")
    return model, script_dir, prompt_dir


def shared_arguments(func):
    options = [
        click.option("--input_file", required=True, help="Path to the input file"),
        click.option("--model", required=False, default="sonnet+", help="Model to use"),
        click.option("--reflect", required=False, default=None, help="Reflect on the changes"),
        click.option("--instruction", required=False, default=None, help="Instruction for processing"),
        click.option("--input_files", default=None, help="Path to the multiple input files"),
        click.option("--sample_files", default=None, help="Path to the multiple sample files"),
        click.option("--auxiliary_files", default=None, help="Path to the auxiliary file"),
        click.option(
            "--figure_inputs",
            required=False,
            default=None,
            help="Path to the figure input file(s). Multiple files can be specified as a comma-separated list.",
        ),
        click.option("--edited_file", default=None, help="Path to the file that are already edited"),
        click.option("--auto_extract_figure", is_flag=True, help="Automatically extract figure paths from the input file"),
        click.option("--auto_extract_tikz_figure", is_flag=True, help="Automatically extract TikZ figure paths from the input file"),
        click.option("--include_tikz_reflection", is_flag=True, help="Include TikZ reflection in the output"),
        click.option("--include_tex_count", is_flag=True, help="Include the tex count statistics in the user message"),
        click.option("--output_files", type=comma_separated_list, default=None, help="Paths to the output files"),
        click.option("--output_name_override", type=str, default=None, help="Override base output name"),
    ]
    for option in options:
        func = option(func)
    return func


def execute_agent(script, agent, model, input_file, **kwargs):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/agents/{script}.py",
        f"--agent={agent}",
        f"--model={model}",
        f"--input_file={input_file}",
    ]

    # Convert figure_inputs to a list if it's a string
    if "figure_inputs" in kwargs and isinstance(kwargs["figure_inputs"], str):
        kwargs["figure_inputs"] = kwargs["figure_inputs"].split(",")

    if kwargs.get("auto_extract_figure"):
        handle_auto_extract_figure(kwargs, input_file)

    # Prepare all input files
    all_input_files = [input_file]
    if kwargs.get("input_files"):
        if isinstance(kwargs["input_files"], str):
            all_input_files.extend(kwargs["input_files"].split(","))
        elif isinstance(kwargs["input_files"], list):
            all_input_files.extend(kwargs["input_files"])

    if kwargs.get("auto_extract_tikz_figure"):
        handle_auto_extract_tikz_figure(kwargs, all_input_files)

    for key, value in kwargs.items():
        if value is not None:
            if isinstance(value, bool):
                if value:
                    command.append(f"--{key}")
            elif key in ["input_files", "figure_inputs", "auxiliary_files", "output_files"]:
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
@shared_arguments
def correct_tex(model, input_file, **kwargs):
    agent = "correct"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"

    execute_agent("edit_tex", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_tex(model, input_file, **kwargs):
    agent = "polish"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_tex", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_tex(model, input_file, **kwargs):
    agent = "draw"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_tex", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_qi(model, input_file, **kwargs):
    execute_agent("edit_lecture", "correct_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_st(model, input_file, **kwargs):
    execute_agent("edit_lecture", "correct_st", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_st(model, input_file, **kwargs):
    agent = "polish_st"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_qi(model, input_file, **kwargs):
    agent = "polish_qi"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_st(model, input_file, **kwargs):
    agent = "draw_st"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_qi(model, input_file, **kwargs):
    agent = "draw_qi"
    if kwargs.get("output_files"):
        agent = f"{agent}_multiple"
    elif kwargs.get("auxiliary_files"):
        agent = f"{agent}_with_auxiliary"
    execute_agent("edit_lecture", agent, model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
@click.option("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
def meeting2text(model, input_file, example_transcript=None, example_edited_transcript=None, agent="transcribe_dual", **kwargs):
    execute_agent(
        "meeting2text",
        agent,
        model,
        input_file,
        example_transcript=example_transcript,
        example_edited_transcript=example_edited_transcript,
        **kwargs,
    )


@click.command()
@shared_arguments
@click.option("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
@click.option("--document_cls", type=str, help="Path to the document class file.")
@click.option("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
def txt2tex(model, input_file, sample_tex=None, document_cls=None, commands_file=None, agent="txt2tex", **kwargs):
    execute_agent("txt2tex", agent, model, input_file, sample_tex=sample_tex, document_cls=document_cls, commands_file=commands_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--sample_chapters", type=str, help="Path to a sample LaTeX file in the desired style.")
@click.option("--sample_paper", type=str, help="Path to a sample LaTeX file in the desired style.")
@click.option("--sample_note", type=str, help="Path to a sample LaTeX file in the desired style.")
def paper2note(model, input_file, **kwargs):
    execute_agent("paper2note", "paper2note", model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
@click.option("--document_cls", type=str, default="lecture.cls", help="Path to the document class file.")
@click.option("--commands_file", type=str, default="command.tex", help="Path to the file containing custom LaTeX commands.")
@click.option("--instruction", type=str, default=None, help="Instruction for processing")
def adapt(model, input_file, sample_tex, document_cls="lecture.cls", commands_file="command.tex", **kwargs):
    execute_agent("adapt", "adapt", model, input_file, sample_tex=sample_tex, document_cls=document_cls, commands_file=commands_file, **kwargs)


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
@click.option("--auxiliary_files", default=None)
def correct_supp_prl(model, input_file, **kwargs):
    execute_agent("edit_prl", "correct_supp_prl", model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--supp_file", type=str, default="supp.tex", help="Path to the supplementary file.")
def reply_letter_prl(model, input_file, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent(
        "rebuttal_prl",
        "reply_letter",
        model,
        input_file,
        supp_file=supp_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.option("--supp_file", type=str, default="supp.tex", help="Path to the supplementary file.")
@click.option("--draft_reply_letter", type=str, help="Path to the draft reply letter.")
def revise_main_prl(model, input_file, supp_file="supp.tex", draft_reply_letter=None, **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent(
        "rebuttal_prl",
        "revise_main",
        model,
        input_file,
        supp_file=supp_file,
        draft_reply_letter=draft_reply_letter,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.option("--main_content", type=str, help="Path to the main content file.")
@click.option("--draft_reply_letter", type=str, help="Path to the draft reply letter.")
@click.option("--draft_main_content", type=str, help="Path to the draft main content file.")
@click.option("--supp_file", type=str, default="supp.tex", help="Path to the supplementary file.")
def revise_supp_prl(model, input_file, main_content, draft_reply_letter, draft_main_content, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent(
        "rebuttal_prl",
        "revise_supp",
        model,
        input_file,
        main_content=main_content,
        draft_reply_letter=draft_reply_letter,
        draft_main_content=draft_main_content,
        supp_file=supp_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.option("--main_content", type=str, help="Path to the main content file.")
@click.option("--supp_file", type=str, default="supp.tex", help="Path to the supplementary file.")
def polish_reply_prl(model, input_file, main_content, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent(
        "rebuttal_prl",
        "polish_reply",
        model,
        input_file,
        main_content=main_content,
        supp_file=supp_file,
        draft_reply_letter=input_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_rebuttal_letter=f"{prompt_dir}/prl/example_rebuttal_letter.txt",
        **kwargs,
    )


@click.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def merge(model, input_file, edited_file, reflect):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/agents/merge.py",
        f"--input_file={input_file}",
        f"--edited_file={edited_file}",
        f"--model={model}",
    ]
    if reflect:
        command.append(f"--reflect={reflect}")
    subprocess.run(command)


@click.command()
@shared_arguments
def paper2cover(model, input_file, **kwargs):
    execute_agent("write_tex", "paper2cover", model, input_file, **kwargs)


@click.command()
@shared_arguments
def write_proposal(model, input_file, **kwargs):
    execute_agent("write_tex", "proposal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def slide2paper(model, input_file, **kwargs):
    execute_agent("write_tex", "slide2paper", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2slide(model, input_file, **kwargs):
    execute_agent("write_tex", "paper2slide", model, input_file, **kwargs)


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
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--agent", required=True, help="Agent to choose")
def clean_single(model, input_file, agent):
    run_clean_single(model, input_file, agent)


@click.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_single(model, input_file, agent, output_name_override):
    run_pack_single(model, input_file, agent, output_name_override)


@click.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--agent", required=True, help="Agent to choose")
def clean_multiple(model, input_file, input_files, agent):
    run_clean_multiple(model, input_file, input_files, agent)


@click.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--agent", required=True, help="Agent to choose")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_multiple(model, input_file, input_files, agent, output_name_override):
    run_pack_multiple(model, input_file, input_files, agent, output_name_override)


@click.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
def latexdiff(input_file, edited_file):
    """Run latexdiff on the given input and edited files."""
    run_latexdiff(input_file, edited_file)


@click.command()
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
def latexdiff_vc(input_file, commit_hash):
    """Run latexdiff-vc on the given input file and commit hash."""
    run_latexdiff_vc(input_file, commit_hash)


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
        print(f"Statistics for {latex_file}:\n {stats}")


@click.command()
@click.argument("latex_file")
def extract_figure_path(latex_file):
    figure_paths = extract_figure_paths(latex_file)
    print(f"Extracted figure file paths: {figure_paths}")


@click.command()
@click.argument("latex_file")
def extract_tikzpictures(latex_file):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    print(f"Compiled TikZ pictures: {compiled_files}")


@click.command()
@shared_arguments
@click.option("--document_type", type=click.Choice(["research", "teaching", "diversity", "cover_letter"]), help="Type of document being revised")
def statement(model, input_file, document_type, **kwargs):
    if document_type is None:
        if "teaching" in input_file.lower():
            agent_sub = "teaching"
        elif "diversity" in input_file.lower():
            agent_sub = "diversity"
        elif "research" in input_file.lower():
            agent_sub = "research"
        else:
            raise ValueError("Document type not recognized")
    else:
        agent_sub = document_type

    print(f"Agent: statement_{agent_sub}")

    execute_agent("application", f"statement_{agent_sub}", model, input_file, **kwargs)


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
    agent_sub = "text2tex"
    if ".tex" in input_file:
        agent_sub = "text2tex_draft"
    print(f"Agent sub: {agent_sub}")
    execute_agent("meeting2text", agent_sub, model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_prl(model, input_file, **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent(
        "rebuttal_prl",
        "revise_prl",
        model,
        input_file,
        supp_file="supp.tex",
        cover_letter="replies/cover_letter.txt",
        # instruction="replies/instruction.txt",
        editor_letter="replies/editor_letter.txt",
        report_a="replies/report_a.txt",
        report_b="replies/report_b.txt",
        example_rebuttal_letter="replies/reply_to_referees.tex",
        draft_reply_letter="replies/reply_to_referees.tex",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.option("--supp_file", type=str, default="supp.tex", help="Path to the supplementary file.")
def draft_rebuttal_prl(model, input_file, **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent("rebuttal_prl", "draft_rebuttal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def revise_rebuttal_prl(model, input_file, **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_agent("rebuttal_prl", "revise_rebuttal", model, input_file, **kwargs)


if __name__ == "__main__":
    cli()

# edit_tex.py
cli.add_command(correct_tex)
cli.add_command(polish_tex)
cli.add_command(draw_tex)

# edit_lecture.py
cli.add_command(correct_st)
cli.add_command(correct_qi)
cli.add_command(polish_st)
cli.add_command(polish_qi)
cli.add_command(draw_st)
cli.add_command(draw_qi)

# meeting2text.py
cli.add_command(meeting2text)
cli.add_command(text2tex)

# txt2tex.py
cli.add_command(txt2tex)

# paper2note.py
cli.add_command(paper2note)

# adapt.py
cli.add_command(adapt)

# merge
cli.add_command(merge)

# edit_prl.py
cli.add_command(correct_prl)
cli.add_command(polish_prl)
cli.add_command(revise_prl)

# reply_prl.py
cli.add_command(draft_rebuttal_prl)
cli.add_command(revise_rebuttal_prl)

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

# write_tex.py
cli.add_command(paper2cover)
cli.add_command(write_proposal)
cli.add_command(slide2paper)
cli.add_command(paper2slide)

# application.py
cli.add_command(statement)

# grant.py
cli.add_command(revise_nsf_grant)
cli.add_command(revise_marie_curie)


if __name__ == "__main__":
    cli()
