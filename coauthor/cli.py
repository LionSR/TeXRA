import click
import subprocess
import os
import glob
import fnmatch
import shutil


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
def polish_tex(model, input_file, auxiliary_file=None, instruction=None, reflect=False):
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
    if reflect:
        command.append("--reflect=True")
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
    if reflect:
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
@click.argument("sample_tex")
@click.argument("document_cls", required=False, default="lecture.cls")
@click.argument("commands_file", required=False, default="command.tex")
def adapt(
    model,
    input_file,
    sample_tex,
    document_cls="lecture.cls",
    commands_file="command.tex",
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
    if reflect:
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
    if reflect:
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
    if reflect:
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
    if reflect:
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
    if reflect:
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
@shared_arguments
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
def polish_st(model, input_file, instruction=None, reflect=False):
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
    if reflect:
        command.append("--reflect=True")
    subprocess.run(command)

@click.command()
@shared_arguments
@click.option(
    "--instruction", required=False, default=None, help="Instruction for processing"
)
def polish_qi(model, input_file, instruction=None, reflect=False):
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
    if reflect:
        command.append("--reflect=True")
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
    if reflect:
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
    if reflect:
        command.append("--reflect=True")
    subprocess.run(command)


@click.command()
def clean():
    excluded_dirs = {"Figs", "Figures", "build", "versions", "figs", "figures", "Notes"}
    patterns = [
        "*_opus.tex",
        "*_sonnet.tex",
        "*_haiku.tex",
        "*_gpt4t.tex",
        "*_gpt4o.tex",
    ]
    patterns_build = [
        "*/build/*_opus*",
        "*/build/*_sonnet*",
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
def clean_single(input_file):
    excluded_dirs = {"Figs", "Figures", "build", "versions", "figs", "figures", "Notes"}
    base_name = os.path.splitext(input_file)[0]
    suffixes = ["_opus", "_sonnet", "_haiku", "_gpt4t", "_gpt4o"]
    patterns = [f"{base_name}*{suffix}*" for suffix in suffixes]
    patterns_build = [f"*/build/{base_name}*{suffix}*" for suffix in suffixes]
    files_to_delete = []

    # Walk through all directories and files, excluding specific directories
    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]  # Modify dirs in-place to exclude certain directories
        for pattern in patterns:
            for filename in fnmatch.filter(files, pattern):
                files_to_delete.append(os.path.join(root, filename))

        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    # Perform the deletion
    for file in files_to_delete:
        os.remove(file)
        print(f"Deleted: {file}\n")

    print(f"Cleanup complete for {input_file}.")


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
cli.add_command(clean)
cli.add_command(clean_build)
cli.add_command(clean_single)

# latexindent
cli.add_command(indent_tex)


if __name__ == "__main__":
    cli()
