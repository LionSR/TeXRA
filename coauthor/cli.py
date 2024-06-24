import click
import shlex
import subprocess
import os
import glob
import shutil
from datetime import datetime
from coauthor.file_utils import run_latexdiff, run_latexdiff_vc
from dotenv import load_dotenv

# Add this at the beginning of the file, after the imports
load_dotenv()


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "opus")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/prompts")
    return model, script_dir, prompt_dir


def comma_separated_list(value):
    return [item.strip() for item in value.split(",")]


# Define a decorator for shared arguments
def shared_arguments(func):
    func = click.argument("input_file")(func)
    func = click.option("--model", required=False, default="opus", help="Model to use")(func)
    func = click.option("--reflect", required=False, default=None, help="Reflect on the changes")(func)
    return func


def shared_arguments_long(func):
    func = shared_arguments(func)
    func = click.option("--instruction", required=False, default=None, help="Instruction for processing")(func)
    func = click.option(
        "--figure_inputs",
        required=False,
        default=None,
        help="Path to the figure input file(s).",
    )(func)
    return func


def execute_task(script, task, model, input_file, **kwargs):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/programs/{script}.py",
        f"--task={task}",
        f"--model={model}",
        f"--input_file={input_file}",
    ]

    for key, value in kwargs.items():
        if value is not None:
            if isinstance(value, bool):
                if value:
                    command.append(f"--{key}")
            elif key in ["input_files", "figure_inputs", "auxiliary_files"]:
                if isinstance(value, str):
                    value = [value]
                command.append(f"--{key}")
                command.extend([shlex.quote(file).strip("'") for file in value])
            else:
                command.append(f"--{key}")
                command.append(shlex.quote(str(value)).strip("'"))

    subprocess.run(command)


@click.group()
def cli():
    pass


@click.command()
@shared_arguments
@click.option("--auxiliary_files", default=None)
def correct_tex(model, input_file, auxiliary_files=None, reflect=False):
    execute_task(
        "edit_tex",
        "correct",
        model,
        input_file,
        auxiliary_files=auxiliary_files,
        reflect=reflect,
    )


@click.command()
@shared_arguments_long
@click.option("--auxiliary_files", default=None, help="Path to the auxiliary file")
def polish_tex(
    model,
    input_file,
    auxiliary_files=None,
    figure_inputs=None,
    instruction=None,
    reflect=True,
):
    execute_task(
        "edit_tex",
        "polish",
        model,
        input_file,
        auxiliary_files=auxiliary_files,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments_long
def draw_tex(model, input_file, figure_inputs, instruction=None, reflect=True):
    execute_task(
        "edit_tex",
        "draw",
        model,
        input_file,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments
def correct_qi(model, input_file, reflect=False):
    execute_task("edit_lecture", "correct_qi", model, input_file, reflect=reflect)


@click.command()
@shared_arguments
def correct_st(model, input_file, reflect=False):
    execute_task("edit_lecture", "correct_st", model, input_file, reflect=reflect)


@click.command()
@shared_arguments_long
def polish_st(model, input_file, figure_inputs, instruction=None, reflect=True):
    execute_task(
        "edit_lecture",
        "polish_st",
        model,
        input_file,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments_long
def polish_qi(model, input_file, figure_inputs, instruction=None, reflect=True):
    execute_task(
        "edit_lecture",
        "polish_qi",
        model,
        input_file,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments_long
def draw_st(model, input_file, figure_inputs, instruction=None, reflect=True):
    execute_task(
        "edit_lecture",
        "draw_st",
        model,
        input_file,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments_long
def draw_qi(model, input_file, figure_inputs, instruction=None, reflect=True):
    execute_task(
        "edit_lecture",
        "draw_qi",
        model,
        input_file,
        figure_inputs=figure_inputs,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("sample_chapters")
@click.argument("sample_paper", required=False, default=None)
@click.argument("sample_note", required=False, default=None)
def paper2note(
    model,
    input_file,
    sample_chapters,
    sample_paper=None,
    sample_note=None,
    reflect=False,
):
    execute_task(
        "paper2note",
        "paper2note",
        model,
        input_file,
        sample_chapters=sample_chapters,
        sample_paper=sample_paper,
        sample_note=sample_note,
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("sample_tex")
@click.argument("document_cls", required=False, default="lecture.cls")
@click.argument("commands_file", required=False, default="command.tex")
@click.option("--instruction", required=False, default=None, help="Instruction for processing")
def adapt(
    model,
    input_file,
    sample_tex,
    document_cls="lecture.cls",
    commands_file="command.tex",
    instruction=None,
    reflect=True,
):
    execute_task(
        "adapt",
        "adapt",
        model,
        input_file,
        sample_tex=sample_tex,
        document_cls=document_cls,
        commands_file=commands_file,
        instruction=instruction,
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("context_file")
@click.argument("example_transcript", required=False, default=None)
@click.argument("example_edited_transcript", required=False, default=None)
def meeting2text(
    model,
    input_file,
    context_file,
    example_transcript=None,
    example_edited_transcript=None,
    reflect=True,
):
    execute_task(
        "meeting2text",
        "transcribe",
        model,
        input_file,
        context_file=context_file,
        example_transcript=example_transcript,
        example_edited_transcript=example_edited_transcript,
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("document_cls", required=False, default="lecture.cls")
@click.argument("commands_file", required=False, default="command.tex")
@click.argument("sample_tex", required=False, default=None)
def txt2tex(
    model,
    input_file,
    document_cls="lecture.cls",
    commands_file="command.tex",
    sample_tex=None,
    reflect=True,
):
    execute_task(
        "txt2tex",
        "txt2tex",
        model,
        input_file,
        document_cls=document_cls,
        commands_file=commands_file,
        sample_tex=sample_tex,
        reflect=reflect,
    )


@click.command()
@shared_arguments
def correct_prl(model, input_file, reflect=True):
    execute_task("edit_prl", "correct_prl", model, input_file, reflect=reflect)


@click.command()
@shared_arguments
@click.option("--auxiliary_files", default=None)
def correct_supp_prl(model, input_file, auxiliary_files=None, reflect=True):
    execute_task(
        "edit_prl",
        "correct_supp_prl",
        model,
        input_file,
        auxiliary_files=auxiliary_files,
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
def reply_letter_prl(model, input_file, supp_file="supp.tex", reflect=True):
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
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
@click.argument("draft_reply_letter")
def revise_main_prl(model, input_file, supp_file="supp.tex", draft_reply_letter=None, reflect=True):
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
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("draft_reply_letter")
@click.argument("draft_main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def revise_supp_prl(
    model,
    input_file,
    main_content,
    draft_reply_letter,
    draft_main_content,
    supp_file="supp.tex",
    reflect=True,
):
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
        reflect=reflect,
    )


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def polish_prl_reply(model, input_file, main_content, supp_file="supp.tex", reflect=True):
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
        reflect=reflect,
    )


@click.command()
def clean_output():
    excluded_dirs = {
        "Figs",
        "Figures",
        "build",
        "Versions",
        "versions",
        "figs",
        "figures",
        "Notes",
    }
    models = ["opus", "sonnet", "sonnet+", "haiku", "gpt4t", "gpt4o"]

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
    excluded_dirs = {
        "Figs",
        "Figures",
        "build",
        "Versions",
        "versions",
        "figs",
        "figures",
        "Notes",
    }

    def remove_files(directory, pattern):
        for file in glob.glob(os.path.join(directory, pattern)):
            os.remove(file)
            print(f"Deleted: {file}")

    def clean_build_dir(directory):
        build_dir = os.path.join(directory, "build")
        if os.path.isdir(build_dir):
            for item in os.listdir(build_dir):
                item_path = os.path.join(build_dir, item)
                if os.path.isfile(item_path) and os.path.getsize(item_path) > 0:
                    os.remove(item_path)
                    print(f"Deleted: {item_path}")
                elif os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                    print(f"Deleted directory: {item_path}")

    # Clean current directory
    remove_files(".", "*.pdf")
    clean_build_dir(".")

    # Clean subdirectories
    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            remove_files(subdir, "*.pdf")
            clean_build_dir(subdir)

    print("All specified files have been deleted.")


@click.command()
def indent_tex():
    excluded_dirs = {
        "Figs",
        "Figures",
        "build",
        "Versions",
        "versions",
        "figs",
        "figures",
        "Notes",
    }
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for file in files:
            if file.endswith(".tex"):
                tex_file = os.path.join(root, file)
                command = ["latexindent", tex_file, "-w", "-s"]
                if latexindent_config:
                    command.append(f"-l={latexindent_config}")
                subprocess.run(
                    command,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )

    # Delete .bak0 and indent.log files
    for pattern in ["**/*.bak0", "**/indent.log"]:
        for file in glob.glob(pattern, recursive=True):
            os.remove(file)

    print("All .tex files have been indented and temporary files have been deleted.")


@click.command()
@click.argument("input_file")
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
def clean_single(input_file, model, reflect, task):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)
    first_task_chunk = task.split("_")[0] if "_" in task else task.split("-")[0]

    def get_patterns(base, model, task, reflect):
        patterns = [f"{base}_{task}_{model}{ext}" for ext in [".pdf", "_diff.pdf", ".tex", "_diff.tex", "_log.txt"]]
        if reflect and reflect != "False":
            patterns.extend([f"{base}_{task}_reflect_{model}{ext}" for ext in [".pdf", "_diff.pdf", ".tex", "_diff.tex", "_log.txt"]])
        return patterns

    file_patterns = get_patterns(base_name, model, first_task_chunk, reflect)
    temp_patterns = [f"{base_name}_{first_task_chunk}_{model}{suffix}" for suffix in ["", "_diff"]]
    if reflect and reflect != "False":
        temp_patterns.extend([f"{base_name}_{first_task_chunk}_reflect_{model}{suffix}" for suffix in ["", "_diff"]])

    temp_extensions = [
        ".aux",
        ".bbl",
        ".blg",
        ".fdb_latexmk",
        ".fls",
        ".log",
        ".out",
        ".synctex.gz",
    ]

    for pattern in file_patterns + [f"{p}{{ext}}" for p in temp_patterns]:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            for ext in [""] + temp_extensions:
                file_path = os.path.join(search_dir, pattern.format(ext=ext))
                if os.path.exists(file_path):
                    os.remove(file_path)
                    print(f"Deleted: {file_path}")

    print(f"Cleanup complete for {input_file}.")


@click.command()
@click.argument("input_file")
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
def pack_single(input_file, model, reflect, task):
    now = datetime.now().strftime("%Y%m%d%H%M")
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)
    output_folder = os.path.join(input_dir, "Versions", f"{now}_{base_name}")
    first_task_chunk = task.split("_")[0] if "_" in task else task.split("-")[0]

    def get_file_patterns(base, task, model, reflect):
        patterns = [f"{base}.pdf"] + [f"{base}_{task}_{model}{ext}" for ext in [".pdf", "_diff.pdf", ".tex", "_diff.tex", "_log.txt"]]
        if reflect and reflect != "False":
            patterns.extend([f"{base}_{task}_reflect_{model}{ext}" for ext in [".pdf", "_diff.pdf", ".tex", "_diff.tex", "_log.txt"]])
        return patterns

    file_patterns = get_file_patterns(base_name, first_task_chunk, model, reflect)

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                if pattern == f"{base_name}.pdf":
                    copied_files.append(file_path)
                else:
                    moved_files.append(file_path)
                break

    if len(moved_files) > 1:
        os.makedirs(output_folder, exist_ok=True)
        for file_path in moved_files:
            shutil.move(file_path, output_folder)
            print(f"Moved: {file_path}")
        for file_path in copied_files:
            shutil.copy(file_path, output_folder)
            print(f"Copied: {file_path}")

        print(f"Files packed into {output_folder}")

    # Remove temporary files
    temp_extensions = [
        ".aux",
        ".bbl",
        ".blg",
        ".fdb_latexmk",
        ".fls",
        ".log",
        ".out",
        ".synctex.gz",
    ]
    temp_patterns = [f"{base_name}_{first_task_chunk}_{model}{suffix}" for suffix in ["", "_diff"]]
    if reflect and reflect != "False":
        temp_patterns.extend([f"{base_name}_{first_task_chunk}_reflect_{model}{suffix}" for suffix in ["", "_diff"]])

    for pattern in temp_patterns:
        for ext in temp_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    os.remove(file_path)
                    print(f"Removed: {file_path}")


@click.command()
@click.argument("input_file")
@click.argument("revision_file")
def latexdiff(input_file, revision_file):
    """Run latexdiff on the given input and revision files."""
    run_latexdiff(input_file, revision_file)


@click.command()
@click.argument("input_file")
@click.argument("commit_hash")
def latexdiff_vc(input_file, commit_hash):
    """Run latexdiff-vc on the given input file and commit hash."""
    run_latexdiff_vc(input_file, commit_hash)


@click.command()
@click.argument("input_file")
@click.argument("commit_hash")
def pack_latexdiff_vc(input_file, commit_hash):
    """Pack the files generated from latexdiff-vc and delete temporary files."""
    now = datetime.now().strftime("%Y%m%d%H%M")
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)
    output_folder = os.path.join(input_dir, "Diffs", f"{now}_{base_name}_{commit_hash}")

    # File patterns to keep
    keep_patterns = [f"{base_name}-diff{commit_hash}{ext}" for ext in [".tex", ".pdf"]]

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

    files_to_move = []
    files_to_delete = []

    for pattern in keep_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                files_to_move.append(file_path)
                # Look for associated build files to delete
                for ext in delete_extensions:
                    temp_file = os.path.splitext(file_path)[0] + ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)
                break

    if files_to_move:
        os.makedirs(output_folder, exist_ok=True)
        for file_path in files_to_move:
            shutil.move(file_path, output_folder)
            print(f"Moved: {file_path}")

        for file_path in files_to_delete:
            os.remove(file_path)
            print(f"Deleted: {file_path}")

        print(f"Files packed into {output_folder}")
    else:
        print("No files found to pack.")


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

# pack single
cli.add_command(pack_single)
cli.add_command(pack_latexdiff_vc)
cli.add_command(latexdiff)
cli.add_command(latexdiff_vc)

if __name__ == "__main__":
    cli()
