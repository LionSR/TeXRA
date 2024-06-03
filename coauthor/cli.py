import click
import subprocess
import os
import glob


@click.group()
def cli():
    pass


@click.command()
@click.argument("input_file")
@click.argument("auxiliary_file", required=False)
def correct_tex(input_file, auxiliary_file=None):
    model = os.getenv("MODEL", "opus")
    script_dir = "/Users/siruilu/Local/AI-Projects/coauthor"
    command = [
        "python",
        f"{script_dir}/correct_article.py",
        "--task=correct",
        f"--model={model}",
        f"--input_file={input_file}",
    ]
    if auxiliary_file:
        command.extend(["--auxiliary_file", auxiliary_file])
    subprocess.run(command)


@click.command()
def clean():
    patterns = [
        "*_opus.tex",
        "*_sonnet.tex",
        "*_haiku.tex",
        "*_gpt4t.tex",
        "*_gpt4o.tex",
    ]
    patterns_build = [
        "build/*_opus*",
        "build/*_sonnet*",
        "build/*_haiku*",
        "build/*_gpt4t*",
        "build/*_gpt4o*",
    ]
    files_to_delete = []
    for pattern in patterns:
        # Search in the current directory and immediate subdirectories
        files_to_delete.extend(glob.glob(pattern))
    for pattern in patterns_build:
        files_to_delete.extend(glob.glob(pattern))

    for file in files_to_delete:
        os.remove(file)

    print("Cleanup complete.")


@click.command()
def indent_tex():
    tex_files = glob.glob(
        "./*.tex", recursive=False
    )  # Find all .tex files in the current directory
    for tex_file in tex_files:
        subprocess.run(
            ["latexindent", tex_file, "-w", "-s", "-l"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    print("All .tex files have been indented.")


@click.command()
def rm_build():
    # Delete all PDF files in the current directory
    pdf_files = glob.glob("./*.pdf", recursive=False)  # Only in the current directory
    for pdf_file in pdf_files:
        os.remove(pdf_file)

    # Delete all files in the build directory
    build_files = glob.glob(
        "./build/*", recursive=False
    )  # Only in the build directory, not subdirectories
    for build_file in build_files:
        os.remove(build_file)

    print("All specified files have been deleted.")


cli.add_command(correct_tex)
cli.add_command(clean)
cli.add_command(indent_tex)
cli.add_command(rm_build)


if __name__ == "__main__":
    cli()
