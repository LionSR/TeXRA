import click
import subprocess
import os
import glob
import fnmatch


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
    excluded_dirs = {'Figs', 'Figures', 'build'}
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
        dirs[:] = [d for d in dirs if d not in excluded_dirs]  # Modify dirs in-place to exclude certain directories
        for pattern in patterns:
            for filename in fnmatch.filter(files, pattern):
                files_to_delete.append(os.path.join(root, filename))
        
        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    # Perform the deletion
    for file in files_to_delete:
        os.remove(file)

    print("Cleanup complete.")


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

    # Delete all PDF files and files in the build directory in subdirectories, excluding 'Figs' and 'Figures'
    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in {'Figs', 'Figures'}]  # Exclude 'Figs' and 'Figures' directories
        for file in files:
            if file.endswith('.pdf') or os.path.basename(os.path.dirname(file)) == 'build':
                os.remove(os.path.join(root, file))

    print("All specified files have been deleted.")


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
    
    # Delete all .bak and indent.log files in the current directory
    files_to_delete = glob.glob("./*.bak0", recursive=False) + glob.glob("./indent.log", recursive=False)
    for file in files_to_delete:
        os.remove(file)

    print("All .tex files have been indented and .bak files have been deleted.")


cli.add_command(correct_tex)
cli.add_command(clean)
cli.add_command(rm_build)
cli.add_command(indent_tex)


if __name__ == "__main__":
    cli()
