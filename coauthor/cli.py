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
    files_to_delete = []
    for pattern in patterns:
        # Search in the current directory and immediate subdirectories
        files_to_delete.extend(glob.glob(pattern))
        files_to_delete.extend(glob.glob(f"./**/{pattern}", recursive=True))

    for file in files_to_delete:
        os.remove(file)

    print("Cleanup complete.")


cli.add_command(correct_tex)
cli.add_command(clean)

if __name__ == "__main__":
    cli()
