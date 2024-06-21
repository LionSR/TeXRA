import click
import subprocess
import os
import glob
import fnmatch
import shutil
from datetime import datetime
from coauthor.file_utils import run_latexdiff, run_latexdiff_vc


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "opus")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/prompts")
    return model, script_dir, prompt_dir


# Define a decorator for shared arguments
def shared_arguments(func):
    func = click.argument("input_file")(func)
    func = click.option("--model", required=False, default="opus", help="Model to use")(
        func
    )
    func = click.option(
        "--reflect", required=False, default=None, help="Reflect on the changes"
    )(func)
    return func


@click.group()
def cli():
    pass


@click.command()
@shared_arguments
@click.option("--auxiliary_file", required=False, default=None)
def correct_tex(model, input_file, auxiliary_file=None, reflect=False):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_tex.py",
        "--task=correct",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if auxiliary_file:
        command.extend(["--auxiliary_file", auxiliary_file])
    subprocess.run(command)


@click.command()
@shared_arguments
@click.option(
    "--auxiliary_file", required=False, default=None, help="Path to the auxiliary file"
)
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
@click.option(
    "--figure_input",
    required=False,
    default=None,
    help="Path to the figure input file.",
)
def polish_tex(
    model,
    input_file,
    auxiliary_file=None,
    figure_input=None,
    instruction=None,
    reflect=False,
):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_tex.py",
        "--task=polish",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if auxiliary_file:
        command.extend(["--auxiliary_file", auxiliary_file])
    if instruction:
        command.extend(["--instruction", instruction])
    if reflect and reflect != "False":
        command.append("--reflect=True")
    if figure_input:
        command.extend(["--figure_input", figure_input])
    subprocess.run(command)


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
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/paper2note.py",
        f"--model={model}",
        "--task=paper2note",
        f"--input_file={input_file}",
        f"--sample_chapters={sample_chapters}",
        f"--sample_paper={sample_paper}",
        f"--sample_note={sample_note}",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("sample_tex")
@click.argument("document_cls", required=False, default="lecture.cls")
@click.argument("commands_file", required=False, default="command.tex")
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
def adapt(
    model,
    input_file,
    sample_tex,
    document_cls="lecture.cls",
    commands_file="command.tex",
    instruction=None,
    reflect=True,
):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/adapt.py",
        "--task=adapt",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--sample_tex={sample_tex}",
        f"--document_cls={document_cls}",
        f"--commands_file={commands_file}",
    ]
    if instruction:
        command.extend(["--instruction", instruction])
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


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
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/meeting2text.py",
        "--task=transcribe",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--context_file={context_file}",
        f"--example_transcript={example_transcript}",
        f"--example_edited_transcript={example_edited_transcript}",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


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
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/txt2tex.py",
        "--task=txt2tex",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--sample_tex={sample_tex}",
        f"--document_cls={document_cls}",
        f"--commands_file={commands_file}",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
def correct_qi(model, input_file, reflect=False):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_lecture.py",
        "--task=correct_qi",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
def correct_st(model, input_file, reflect=False):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_lecture.py",
        "--task=correct_st",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
@click.option(
    "--figure_input",
    required=False,
    default=None,
    help="Path to the figure input file.",
)
def polish_st(model, input_file, figure_input, instruction=None, reflect=False):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_lecture.py",
        "--task=polish_st",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if instruction:
        command.extend(["--instruction", instruction])
    if reflect and reflect != "False":
        command.append("--reflect=True")
    if figure_input:
        command.extend(["--figure_input", figure_input])
    subprocess.run(command)


@click.command()
@shared_arguments
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
@click.option(
    "--figure_input",
    required=False,
    default=None,
    help="Path to the figure input file.",
)
def polish_qi(model, input_file, figure_input, instruction=None, reflect=False):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_lecture.py",
        "--task=polish_qi",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if instruction:
        command.extend(["--instruction", instruction])
    if reflect and reflect != "False":
        command.append("--reflect=True")
    if figure_input:
        command.extend(["--figure_input", figure_input])
    subprocess.run(command)


@click.command()
@shared_arguments
@click.option("--auxiliary_file", required=False, default=None)
def correct_supp_prl(model, input_file, auxiliary_file=None, reflect=True):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_prl.py",
        "--task=correct_supp_prl",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--auxiliary_file={auxiliary_file}",
        f"--reflect={reflect}",
    ]
    subprocess.run(command)


@click.command()
@shared_arguments
def correct_prl(model, input_file, reflect=True):
    model, script_dir, _ = get_common_env(model)
    command = [
        "python",
        f"{script_dir}/edit_prl.py",
        "--task=correct_prl",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--reflect={reflect}",
    ]
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
def reply_letter_prl(input_file, supp_file="supp.tex", reflect=True):
    model, script_dir, prompt_dir = get_common_env()
    command = [
        "python",
        f"{script_dir}/prl_reply.py",
        "--task=reply_letter",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--supp_file={supp_file}",
        "--cover_letter=rebuttal/cover_letter.txt",
        "--instruction=rebuttal/instruction.txt",
        "--editor_letter=rebuttal/editor_letter.txt",
        "--report_a=rebuttal/report_a.txt",
        "--report_b=rebuttal/report_b.txt",
        f"--example_reply_letter={prompt_dir}/prl_reply/example_reply_letter.txt",
        f"--reflect={reflect}",
    ]
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("supp_file", required=False, default="supp.tex")
@click.argument("draft_reply_letter")
def revise_main_prl(
    input_file, supp_file="supp.tex", draft_reply_letter=None, reflect=True
):
    model, script_dir, prompt_dir = get_common_env()
    command = [
        "python",
        f"{script_dir}/prl_reply.py",
        "--task=revise_main",
        f"--model={model}",
        f"--example_reply_letter={prompt_dir}/prl_reply/example_reply_letter.txt",
        f"--input_file={input_file}",
        f"--supp_file={supp_file}",
        f"--draft_reply_letter={draft_reply_letter}",
        "--cover_letter=rebuttal/cover_letter.txt",
        "--instruction=rebuttal/instruction.txt",
        "--editor_letter=rebuttal/editor_letter.txt",
        "--report_a=rebuttal/report_a.txt",
        "--report_b=rebuttal/report_b.txt",
        f"--reflect={reflect}",
    ]
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("draft_reply_letter")
@click.argument("draft_main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def revise_supp_prl(
    input_file,
    main_content,
    draft_reply_letter,
    draft_main_content,
    supp_file="supp.tex",
    reflect=True,
):
    model, script_dir, prompt_dir = get_common_env()
    command = [
        "python",
        f"{script_dir}/prl_reply.py",
        "--task=revise_supp",
        f"--model={model}",
        f"--example_reply_letter={prompt_dir}/prl_reply/example_reply_letter.txt",
        f"--input_file={input_file}",
        f"--main_content={main_content}",
        f"--supp_file={supp_file}",
        f"--draft_reply_letter={draft_reply_letter}",
        f"--draft_main_content={draft_main_content}",
        "--cover_letter=rebuttal/cover_letter.txt",
        "--instruction=rebuttal/instruction.txt",
        "--editor_letter=rebuttal/editor_letter.txt",
        "--report_a=rebuttal/report_a.txt",
        "--report_b=rebuttal/report_b.txt",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("main_content")
@click.argument("supp_file", required=False, default="supp.tex")
def polish_prl_reply(input_file, main_content, supp_file="supp.tex", reflect=True):
    model, script_dir, prompt_dir = get_common_env()
    command = [
        "python",
        f"{script_dir}/prl_reply.py",
        "--task=polish_reply",
        f"--model={model}",
        f"--input_file={input_file}",
        f"--main_content={main_content}",
        f"--supp_file={supp_file}",
        f"--draft_reply_letter={input_file}",
        f"--example_reply_letter={prompt_dir}/prl_reply/example_reply_letter.txt",
        "--cover_letter=rebuttal/cover_letter.txt",
        "--instruction=rebuttal/instruction.txt",
        "--editor_letter=rebuttal/editor_letter.txt",
        "--report_a=rebuttal/report_a.txt",
        "--report_b=rebuttal/report_b.txt",
    ]
    if reflect and reflect != "False":
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
def clean_output():
    excluded_dirs = {"Figs", "Figures", "build", "versions", "figs", "figures", "Notes"}
    patterns = [
        "*_opus.tex",
        "*_sonnet.tex",
        "*_sonnet+.tex",
        "*_haiku.tex",
        "*_gpt4t.tex",
        "*_gpt4o.tex",
        "*_opus_diff.tex",
        "*_sonnet_*.tex",
        "*_sonnet+_*.tex",
        "*_haiku_*.tex",
        "*_gpt4t_*.tex",
        "*_gpt4o_*.tex",
    ]
    patterns_build = [
        "*/build/*_opus*",
        "*/build/*_sonnet*",
        "*/build/*_sonnet+*",
        "*/build/*_haiku*",
        "*/build/*_gpt4t*",
        "*/build/*_gpt4o*",
    ]
    files_to_delete = []

    # Walk through all directories and files, excluding specific directories
    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [
            d for d in dirs if d not in excluded_dirs
        ]  # Modify dirs in-place to exclude certain directories
        for pattern in patterns:
            for filename in fnmatch.filter(files, pattern):
                files_to_delete.append(os.path.join(root, filename))

        for pattern in patterns_build:
            files_to_delete.extend(
                glob.glob(os.path.join(root, pattern), recursive=True)
            )

    # Perform the deletion
    for file in files_to_delete:
        print(f"Deleted: {file}")
        os.remove(file)

    print("Cleanup complete.")


@click.command()
def clean_build():
    # Delete all PDF files in the current directory
    pdf_files = glob.glob("./*.pdf", recursive=False)  # Only in the current directory
    for pdf_file in pdf_files:
        os.remove(pdf_file)

    # Delete all non-empty files in the build directory
    build_files = glob.glob(
        "./build/*", recursive=False
    )  # Only in the build directory, not subdirectories
    for build_file in build_files:
        if os.path.isfile(build_file) and os.path.getsize(build_file) > 0:
            os.remove(build_file)
        elif os.path.isdir(build_file) and os.listdir(build_file):
            shutil.rmtree(build_file)

    # Delete all PDF files and files in the build directory in subdirectories
    excluded_dirs = {"Figs", "Figures", "build", "versions", "figs", "figures", "Notes"}
    non_forbidden_subdirs = []
    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        non_forbidden_subdirs.extend([os.path.join(root, d) for d in dirs])

    for subdir in non_forbidden_subdirs:
        for file in os.listdir(subdir):
            if file.endswith(".pdf"):
                os.remove(os.path.join(subdir, file))

        build_dir = os.path.join(subdir, "build")
        if os.path.isdir(build_dir) and os.listdir(build_dir):
            shutil.rmtree(build_dir)

    print("All specified files have been deleted.")


@click.command()
def indent_tex():
    excluded_dirs = {"Figs", "Figures", "build", "versions", "figs", "figures", "Notes"}
    non_forbidden_subdirs = []
    tex_files = []

    # Find all .tex files in the current directory and subdirectories, excluding specific directories
    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for file in files:
            if file.endswith(".tex"):
                tex_files.append(os.path.join(root, file))
        non_forbidden_subdirs.extend([os.path.join(root, d) for d in dirs])

    latexindent_config = os.environ.get(
        "LATEXINDENT_CONFIG", "/Users/siruilu/Local/TEX/latexindent.yaml"
    )

    for tex_file in tex_files:
        subprocess.run(
            [
                "latexindent",
                tex_file,
                "-w",
                "-s",
                f"-l={latexindent_config}",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    # Delete all .bak and indent.log files in the current directory
    files_to_delete = glob.glob("./*.bak0", recursive=True) + glob.glob(
        "./indent.log", recursive=True
    )
    for file in files_to_delete:
        os.remove(file)

    # Delete all .bak and indent.log files in non-forbidden subdirectories
    for subdir in non_forbidden_subdirs:
        files_to_delete = glob.glob(
            os.path.join(subdir, "*.bak0"), recursive=True
        ) + glob.glob(os.path.join(subdir, "indent.log"), recursive=True)
        for file in files_to_delete:
            os.remove(file)

    print("All .tex files have been indented and .bak files have been deleted.")


@click.command()
@click.argument("input_file")
@click.option("--model", required=False, default="opus", help="Model to use")
@click.option("--reflect", required=False, default=None, help="Reflect on the changes")
@click.option("--task", required=True, help="Task to perform")
def clean_single(input_file, model, reflect, task):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    first_task_chunk = task.split("_")[0] if "_" in task else task.split("-")[0]

    file_patterns = [
        f"{base_name}_{first_task_chunk}_{model}.pdf",
        f"{base_name}_{first_task_chunk}_{model}_diff.pdf",
        f"{base_name}_{first_task_chunk}_{model}.tex",
        f"{base_name}_{first_task_chunk}_{model}_diff.tex",
        f"{base_name}_{first_task_chunk}_{model}_log.txt",
    ]

    if reflect and reflect != "False":
        file_patterns.extend([
            f"{base_name}_{first_task_chunk}_reflect_{model}.pdf",
            f"{base_name}_{first_task_chunk}_reflect_{model}_diff.pdf",
            f"{base_name}_{first_task_chunk}_reflect_{model}.tex",
            f"{base_name}_{first_task_chunk}_reflect_{model}_diff.tex",
            f"{base_name}_{first_task_chunk}_reflect_{model}_log.txt",
        ])

    temp_file_extensions = [
        ".aux", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".log", ".out", ".synctex.gz"
    ]

    temp_file_patterns = [
        f"{base_name}_{first_task_chunk}_{model}_diff{{ext}}",
        f"{base_name}_{first_task_chunk}_{model}{{ext}}",
        f"{base_name}_{first_task_chunk}_reflect_{model}{{ext}}",
        f"{base_name}_{first_task_chunk}_reflect_{model}_diff{{ext}}",
    ]

    files_to_delete = []

    # Add main files to delete list
    for pattern in file_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                files_to_delete.append(file_path)

    # Add temporary files to delete list
    for pattern in temp_file_patterns:
        for ext in temp_file_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, pattern.format(ext=ext))
                if os.path.exists(file_path):
                    files_to_delete.append(file_path)

    # Perform the deletion
    for file in files_to_delete:
        os.remove(file)
        print(f"Deleted: {file}")

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
    output_folder_prefix = os.path.join(input_dir, "Versions")
    output_folder = os.path.join(output_folder_prefix, f"{now}_{base_name}")

    first_task_chunk = task.split("_")[0] if "_" in task else task.split("-")[0]

    file_patterns = [
        f"{base_name}.pdf",
        f"{base_name}_{first_task_chunk}_{model}.pdf",
        f"{base_name}_{first_task_chunk}_{model}_diff.pdf",
        f"{base_name}_{first_task_chunk}_{model}.tex",
        f"{base_name}_{first_task_chunk}_{model}_diff.tex",
        f"{base_name}_{first_task_chunk}_{model}_log.txt",
    ]

    if reflect and reflect != "False":
        file_patterns.extend(
            [
                f"{base_name}_{first_task_chunk}_reflect_{model}.pdf",
                f"{base_name}_{first_task_chunk}_reflect_{model}_diff.pdf",
                f"{base_name}_{first_task_chunk}_reflect_{model}.tex",
                f"{base_name}_{first_task_chunk}_reflect_{model}_diff.tex",
                f"{base_name}_{first_task_chunk}_reflect_{model}_log.txt",
            ]
        )

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

    # Remove temporary files
    temp_file_extensions = [
        ".aux",
        ".bbl",
        ".blg",
        ".fdb_latexmk",
        ".fls",
        ".log",
        ".out",
        ".synctex.gz",
    ]

    temp_file_patterns = [
        "{base_name}_{first_task_chunk}_{model}_diff{ext}",
        "{base_name}_{first_task_chunk}_{model}{ext}",
        "{base_name}_{first_task_chunk}_reflect_{model}{ext}",
        "{base_name}_{first_task_chunk}_reflect_{model}_diff{ext}",
    ]

    for pattern in temp_file_patterns:
        for ext in temp_file_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(
                    search_dir,
                    pattern.format(
                        base_name=base_name,
                        first_task_chunk=first_task_chunk,
                        model=model,
                        ext=ext,
                    ),
                )
                if os.path.exists(file_path):
                    os.remove(file_path)
                    print(f"Removed: {file_path}")

    if len(moved_files) > 1:
        print(f"Files packed into {output_folder}")


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


if __name__ == "__main__":
    cli()

# edit_tex.py
cli.add_command(correct_tex)
cli.add_command(polish_tex)

# edit_lecture.py
cli.add_command(correct_qi)
cli.add_command(correct_st)
cli.add_command(polish_st)
cli.add_command(polish_qi)

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
cli.add_command(latexdiff)
cli.add_command(latexdiff_vc)

if __name__ == "__main__":
    cli()
