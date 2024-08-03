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
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/tasks")
    return model, script_dir, prompt_dir


def shared_arguments(func):
    options = [
        click.option("--input_file", required=True, help="Path to the input file"),
        click.option("--model", required=False, default="opus", help="Model to use"),
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


def execute_task(script, task, model, input_file, **kwargs):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/tasks/{script}.py",
        f"--task={task}",
        f"--model={model}",
        f"--input_file={input_file}",
    ]

    # Convert figure_inputs to a list if it's a string
    if "figure_inputs" in kwargs and isinstance(kwargs["figure_inputs"], str):
        kwargs["figure_inputs"] = kwargs["figure_inputs"].split(",")

    # this logic needs to be changed for multiple file output
    handle_auto_extract_figure(kwargs, input_file)
    all_input_files = [input_file] + (kwargs.get("input_files") or [])
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
    task = "correct"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"

    execute_task("edit_tex", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_tex(model, input_file, **kwargs):
    task = "polish"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_tex", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_tex(model, input_file, **kwargs):
    task = "draw"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_tex", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_qi(model, input_file, **kwargs):
    execute_task("edit_lecture", "correct_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
def correct_st(model, input_file, **kwargs):
    execute_task("edit_lecture", "correct_st", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_st(model, input_file, **kwargs):
    task = "polish_st"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_lecture", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_qi(model, input_file, **kwargs):
    task = "polish_qi"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_lecture", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_st(model, input_file, **kwargs):
    task = "draw_st"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_lecture", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_qi(model, input_file, **kwargs):
    task = "draw_qi"
    if kwargs.get("output_files"):
        task = f"{task}_multiple"
    elif kwargs.get("auxiliary_files"):
        task = f"{task}_with_auxiliary"
    execute_task("edit_lecture", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
@click.option("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
def meeting2text(model, input_file, example_transcript=None, example_edited_transcript=None, task="transcribe", **kwargs):
    execute_task(
        "meeting2text",
        task,
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
def txt2tex(model, input_file, sample_tex=None, document_cls=None, commands_file=None, task="txt2tex", **kwargs):
    execute_task("txt2tex", task, model, input_file, sample_tex=sample_tex, document_cls=document_cls, commands_file=commands_file, **kwargs)


@click.command()
@shared_arguments
@click.argument("sample_chapters")
@click.argument("sample_paper", required=False, default=None)
@click.argument("sample_note", required=False, default=None)
def paper2note(model, input_file, sample_chapters, sample_paper=None, sample_note=None, **kwargs):
    execute_task(
        "paper2note", "paper2note", model, input_file, sample_chapters=sample_chapters, sample_paper=sample_paper, sample_note=sample_note, **kwargs
    )


@click.command()
@shared_arguments
@click.argument("sample_tex")
@click.argument("document_cls", required=False, default="lecture.cls")
@click.argument("commands_file", required=False, default="command.tex")
@click.option("--instruction", required=False, default=None, help="Instruction for processing")
def adapt(model, input_file, sample_tex, document_cls="lecture.cls", commands_file="command.tex", **kwargs):
    execute_task("adapt", "adapt", model, input_file, sample_tex=sample_tex, document_cls=document_cls, commands_file=commands_file, **kwargs)


@click.command()
@shared_arguments
def correct_prl(model, input_file, **kwargs):
    execute_task("edit_prl", "correct_prl", model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--auxiliary_files", default=None)
def correct_supp_prl(model, input_file, **kwargs):
    execute_task("edit_prl", "correct_supp_prl", model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
def reply_letter_prl(model, input_file, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_task(
        "prl_reply",
        "reply_letter",
        model,
        input_file,
        supp_file=supp_file,
        cover_letter="rebuttal/cover_letter.txt",
        instruction="rebuttal/instruction.txt",
        editor_letter="rebuttal/editor_letter.txt",
        report_a="rebuttal/report_a.txt",
        report_b="rebuttal/report_b.txt",
        example_reply_letter=f"{prompt_dir}/prl_reply/example_reply_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
@click.argument("draft_reply_letter")
def revise_main_prl(model, input_file, supp_file="supp.tex", draft_reply_letter=None, **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_task(
        "prl_reply",
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
        example_reply_letter=f"{prompt_dir}/prl_reply/example_reply_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("draft_reply_letter")
@click.argument("draft_main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def revise_supp_prl(model, input_file, main_content, draft_reply_letter, draft_main_content, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_task(
        "prl_reply",
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
        example_reply_letter=f"{prompt_dir}/prl_reply/example_reply_letter.txt",
        **kwargs,
    )


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def polish_prl_reply(model, input_file, main_content, supp_file="supp.tex", **kwargs):
    _, _, prompt_dir = get_common_env(model)
    execute_task(
        "prl_reply",
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
        example_reply_letter=f"{prompt_dir}/prl_reply/example_reply_letter.txt",
        **kwargs,
    )


@click.command()
@click.option("--model", required=False, default="sonnet+", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--edited_file", required=True, help="Path to the edited file")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
def merge(model, input_file, edited_file, reflect):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/tasks/merge.py",
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
    execute_task("write_tex", "paper2cover", model, input_file, **kwargs)


@click.command()
@shared_arguments
def write_proposal(model, input_file, **kwargs):
    execute_task("write_tex", "proposal", model, input_file, **kwargs)


@click.command()
@shared_arguments
def slide2paper(model, input_file, **kwargs):
    execute_task("write_tex", "slide2paper", model, input_file, **kwargs)


@click.command()
@shared_arguments
def paper2slide(model, input_file, **kwargs):
    execute_task("write_tex", "paper2slide", model, input_file, **kwargs)


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
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
def clean_single(model, input_file, reflect, task):
    run_clean_single(model, input_file, reflect, task)


@click.command()
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_single(model, input_file, reflect, task, output_name_override):
    run_pack_single(model, input_file, reflect, task, output_name_override)


@click.command()
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
def clean_multiple(model, input_files, reflect, task):
    run_clean_multiple(model, input_files, reflect, task)


@click.command()
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_files", required=True, type=comma_separated_list, help="Paths to the input files")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_multiple(model, input_files, reflect, task, output_name_override):
    run_pack_multiple(model, input_files, reflect, task, output_name_override)


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
    if "teaching" in input_file.lower():
        task_type = "teaching"
    elif "diversity" in input_file.lower():
        task_type = "diversity"
    elif "research" in input_file.lower():
        task_type = "research"
    else:
        raise ValueError("Document type not recognized")

    print(f"Task type: {task_type}")

    execute_task("faculty", f"statement_{task_type}", model, input_file, **kwargs)


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

# txt2tex.py
cli.add_command(txt2tex)

# paper2note.py
cli.add_command(paper2note)

# adapt.py
cli.add_command(adapt)

# merge
cli.add_command(merge)

# prl_edit.py
cli.add_command(correct_prl)
cli.add_command(correct_supp_prl)

# prl_reply.py
cli.add_command(reply_letter_prl)
cli.add_command(revise_main_prl)
cli.add_command(revise_supp_prl)
cli.add_command(polish_prl_reply)

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

# faculty.py
cli.add_command(statement)


if __name__ == "__main__":
    cli()
