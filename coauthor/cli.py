import click
import subprocess
import os


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


cli.add_command(correct_tex)

if __name__ == "__main__":
    cli()
