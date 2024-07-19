import sys
import os
import click
import shlex
import subprocess
import glob
import shutil
from datetime import datetime
from dotenv import load_dotenv
from termcolor import colored

# Add the parent directory to the system path for the windows users
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from coauthor.tex_tools import run_latexdiff, run_latexdiff_vc, get_tex_count
from coauthor.figure_tools import extract_figure_paths, extract_and_compile_tikzpictures_with_labels

load_dotenv()


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "sonnet+")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/tasks")
    return model, script_dir, prompt_dir


def comma_separated_list(value):
    return [item.strip() for item in value.split(",")]


# Define a decorator for shared arguments
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

    handle_auto_extract_figure(kwargs, input_file)
    handle_auto_extract_tikz_figure(kwargs, input_file)

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


def handle_auto_extract_figure(kwargs, input_file):
    if kwargs.get("auto_extract_figure"):
        extracted_figure_paths = extract_figure_paths(input_file)
        print("Extracting figure paths:", colored(extracted_figure_paths, "cyan"))
        if extracted_figure_paths:
            if kwargs.get("figure_inputs") is None or kwargs.get("figure_inputs") == []:
                kwargs["figure_inputs"] = extracted_figure_paths
            else:
                kwargs["figure_inputs"].extend(extracted_figure_paths)


def handle_auto_extract_tikz_figure(kwargs, input_file):
    if kwargs.get("auto_extract_tikz_figure"):
        extracted_tikz_figure_paths = extract_and_compile_tikzpictures_with_labels(input_file)
        if extracted_tikz_figure_paths:
            if kwargs.get("figure_inputs") is None or kwargs.get("figure_inputs") == []:
                kwargs["figure_inputs"] = extracted_tikz_figure_paths
            else:
                kwargs["figure_inputs"].extend(extracted_tikz_figure_paths)


def handle_tex_count(kwargs, input_file):
    if kwargs.get("include_tex_count"):
        tex_count_stats = get_tex_count(input_file)
        if tex_count_stats:
            instruction = kwargs.get("instruction", "")
            kwargs["instruction"] = f"Tex Count Statistics:\n{tex_count_stats}\n\n{instruction}"


@click.group()
def cli():
    pass


@click.command()
@shared_arguments
def correct_tex(model, input_file, **kwargs):
    execute_task("edit_tex", "correct", model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_tex(model, input_file, **kwargs):
    task = "polish" if not kwargs.get("input_files") else "polish_long"
    execute_task("edit_tex", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_tex(model, input_file, **kwargs):
    execute_task("edit_tex", "draw", model, input_file, **kwargs)


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
    task = "polish_st" if not kwargs.get("input_files") else "polish_st_long"
    execute_task("edit_lecture", task, model, input_file, **kwargs)


@click.command()
@shared_arguments
def polish_qi(model, input_file, **kwargs):
    execute_task("edit_lecture", "polish_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_st(model, input_file, **kwargs):
    execute_task("edit_lecture", "draw_st", model, input_file, **kwargs)


@click.command()
@shared_arguments
def draw_qi(model, input_file, **kwargs):
    execute_task("edit_lecture", "draw_qi", model, input_file, **kwargs)


@click.command()
@shared_arguments
@click.option("--context_file", type=str, required=True, help="Path to the file containing the context for the discussion transcript.")
@click.option("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
@click.option("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
def meeting2text(model, input_file, context_file, example_transcript=None, example_edited_transcript=None, task="transcribe", **kwargs):
    execute_task(
        "meeting2text",
        task,
        model,
        input_file,
        context_file=context_file,
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
def clean_output():
    excluded_dirs = {"Figs", "Figures", "build", "Versions", "versions", "figs", "figures", "Notes"}
    models = ["opus", "sonnet", "sonnet+", "haiku", "gpt4t", "gpt4o", "gpt4o-"]

    patterns = [f"*_{model}*.tex" for model in models]
    patterns_build = [f"*/build/*_{model}*" for model in models]

    files_to_delete = []

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]

        for pattern in patterns:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern)))

        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    for file in set(files_to_delete):
        try:
            if os.path.exists(file):  # Check if file exists before attempting to delete
                os.remove(file)
                print(f"Deleted: {file}")
            else:
                print(f"File not found: {file}")
        except OSError as e:
            print(f"Error deleting {file}: {e}")

    print("Cleanup complete.")


@click.command()
def clean_build():
    excluded_dirs = {"Figs", "Figures", "build", "Versions", "versions", "figs", "figures", "Notes"}

    def remove_files(directory, pattern):
        for file in glob.glob(os.path.join(directory, pattern)):
            os.remove(file)
            print(f"Deleted: {file}")

    def clean_build_dir(directory):
        build_dir = os.path.join(directory, "build")
        if os.path.isdir(build_dir):
            for item in os.listdir(build_dir):
                item_path = os.path.join(build_dir, item)
                # if os.path.isfile(item_path) and os.path.getsize(item_path) > 0:
                if os.path.isfile(item_path):
                    os.remove(item_path)
                    print(f"Deleted: {item_path}")
                elif os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                    print(f"Deleted directory: {item_path}")

    # Clean current directory
    clean_build_dir(".")

    # Clean subdirectories
    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            clean_build_dir(subdir)

    print("All specified files have been deleted.")


@click.command()
def indent_tex():
    excluded_dirs = {"Figs", "Figures", "build", "Versions", "versions", "figs", "figures", "Notes"}
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for file in files:
            if file.endswith(".tex"):
                tex_file = os.path.join(root, file)
                command = ["latexindent", tex_file, "-w", "-s"]
                if latexindent_config:
                    command.append(f"-l={latexindent_config}")
                subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Delete .bak0 and indent.log files
    for pattern in ["**/*.bak0", "**/indent.log"]:
        for file in glob.glob(pattern, recursive=True):
            os.remove(file)

    print("All .tex files have been indented and temporary files have been deleted.")


def get_first_task_chunk(task):
    if task.startswith("write-"):
        return task.split("-")[1]
    else:
        return task.split("_")[0] if "_" in task else task.split("-")[0]


def get_file_patterns(base, model, task, reflect):
    patterns = [f"{base}_{task}_{model}", f"{base}_{task}_{model}_diff", f"{base}_{task}_full_{model}", f"{base}_{task}_full_{model}_diff"]
    if reflect and reflect != "False":
        patterns.extend(
            [
                f"{base}_{task}_reflect_{model}",
                f"{base}_{task}_reflect_{model}_diff",
                f"{base}_{task}_reflect_{model}_diffdiff",
                f"{base}_{task}_reflect_full_{model}",
                f"{base}_{task}_reflect_full_{model}_diff",
            ]
        )
    return patterns


@click.command()
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def clean_single(model, input_file, reflect, task, output_name_override):
    base_name = os.path.splitext(os.path.basename(output_name_override or input_file))[0]
    input_dir = os.path.dirname(input_file)
    first_task_chunk = get_first_task_chunk(task)

    file_patterns = get_file_patterns(base_name, model, first_task_chunk, reflect)

    # Add the thinking.txt pattern separately
    file_patterns.extend([f"{base_name}_{first_task_chunk}_{model}_thinking", f"{base_name}_{first_task_chunk}_reflect_{model}_thinking"])

    extensions = [".pdf", ".tex", ".text", ".bib", ".aux", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".log", ".out", ".synctex.gz", ".txt"]

    print(f"file_patterns: {file_patterns}")
    print(f"extensions: {extensions}")

    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    try:
                        if os.path.isfile(file_path):
                            os.remove(file_path)
                            print(f"Deleted: {file_path}")
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                            print(f"Deleted directory: {file_path}")
                    except PermissionError:
                        print(f"Warning: Unable to delete {file_path}. It may be in use or you may not have permission.")
                    except Exception as e:
                        print(f"Error deleting {file_path}: {str(e)}")

    print(f"Cleanup complete for {input_file}.")


@click.command()
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
@click.option("--output_name_override", type=str, default=None, help="Override base output name")
def pack_single(model, input_file, reflect, task, output_name_override):
    base_name = os.path.splitext(os.path.basename(output_name_override or input_file))[0]
    input_dir = os.path.dirname(input_file)
    first_task_chunk = get_first_task_chunk(task)

    now = datetime.now().strftime("%Y%m%d%H%M")
    output_folder = os.path.join(input_dir, "Versions", f"{now}_{base_name}_{task}_{model}")

    file_patterns = get_file_patterns(base_name, model, first_task_chunk, reflect)

    # Add the thinking.txt pattern separately
    file_patterns.extend([f"{base_name}_{first_task_chunk}_{model}_thinking", f"{base_name}_{first_task_chunk}_reflect_{model}_thinking"])

    # Add the original file pattern
    file_patterns.append(base_name)

    extensions = [".pdf", ".tex", ".txt", ".text"]

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    if file_path == input_file or pattern == base_name:
                        copied_files.append(file_path)
                    else:
                        moved_files.append(file_path)
                    break

    if moved_files or copied_files:
        os.makedirs(output_folder, exist_ok=True)
        for file_path in moved_files:
            shutil.move(file_path, output_folder)
            print(f"Moved: {file_path}")
        for file_path in copied_files:
            shutil.copy(file_path, output_folder)
            print(f"Copied: {file_path}")

        print(f"Files packed into {output_folder}")

    # Remove temporary files
    temp_extensions = [".aux", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".log", ".out", ".synctex.gz", ".bib"]
    for pattern in file_patterns:
        for ext in temp_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path) and file_path != input_file:  # Ensure we don't delete the input file
                    os.remove(file_path)
                    print(f"Deleted: {file_path}")

    print(f"Packing complete for {input_file}.")


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
@click.option("--input_file", required=True, help="Path to the input file")
@click.option("--commit_hash", required=True, help="Commit hash to compare against")
@click.option("--clean", is_flag=True, default=False, help="Clean files without packing")
def pack_latexdiff_vc(input_file, commit_hash, clean):
    """Pack or clean the files generated from latexdiff-vc."""
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    if not clean:
        now = datetime.now().strftime("%Y%m%d%H%M")
        output_folder = os.path.join(input_dir, "Diffs", f"{now}_{base_name}_{commit_hash}")

    # File patterns to keep/delete
    file_patterns = [f"{base_name}-diff{commit_hash}{ext}" for ext in [".tex", ".pdf"]]

    # Build file extensions to delete
    delete_extensions = [
        ".aux",
        ".bbl",
        ".blg",
        ".fdb_latexmk",
        ".fls",
        ".log",
        ".out",
        ".synctex.gz",
    ]

    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                files_to_process.append(file_path)
                # Look for associated build files to delete
                for ext in delete_extensions:
                    temp_file = os.path.splitext(file_path)[0] + ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)
                break

    if files_to_process:
        if clean:
            for file_path in files_to_process + files_to_delete:
                os.remove(file_path)
                print(f"Deleted: {file_path}")
            print("Cleanup complete.")
        else:
            os.makedirs(output_folder, exist_ok=True)
            for file_path in files_to_process:
                shutil.move(file_path, output_folder)
                print(f"Moved: {file_path}")

            for file_path in files_to_delete:
                os.remove(file_path)
                print(f"Deleted: {file_path}")

            print(f"Files packed into {output_folder}")
    else:
        print("No files found to process.")


@click.command()
@click.argument("latex_file")
def tex_count(latex_file):
    stats = get_tex_count(latex_file)
    if stats is not None:
        print(f"Statistics for {latex_file}:")
        print(stats)


@click.command()
@click.argument("latex_file")
def extract_figure_path(latex_file):
    figure_paths = extract_figure_paths(latex_file)
    print("Extracted figure file paths:")
    for figure in figure_paths:
        print(figure)


@click.command()
@click.argument("latex_file")
def extract_tikzpictures(latex_file):
    compiled_files = extract_and_compile_tikzpictures_with_labels(latex_file)
    print("Compiled TikZ pictures:")
    for file in compiled_files:
        print(file)


@click.command()
@shared_arguments
def write_cover(model, input_file, **kwargs):
    execute_task("write_tex", "cover", model, input_file, **kwargs)


@click.command()
@shared_arguments
def write_proposal(model, input_file, **kwargs):
    execute_task("write_tex", "proposal", model, input_file, **kwargs)


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

# latexindent
cli.add_command(indent_tex)

# merge
cli.add_command(merge)

# pack single
cli.add_command(pack_single)

# latexdiff
cli.add_command(latexdiff)
cli.add_command(latexdiff_vc)
cli.add_command(pack_latexdiff_vc)


# tools
cli.add_command(tex_count)
cli.add_command(extract_figure_path)
cli.add_command(extract_tikzpictures)

# write_tex.py
cli.add_command(write_cover)
cli.add_command(write_proposal)


if __name__ == "__main__":
    cli()
