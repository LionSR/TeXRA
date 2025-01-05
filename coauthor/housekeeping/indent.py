import os
import glob
import subprocess

from ..logger import logger
from ..utils.file import delete_file

from .constants import EXCLUDED_DIRS


def run_indent_tex() -> None:
    """Recursively indent all .tex files using latexindent and clean up temporary files."""
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for file in files:
            if file.endswith(".tex"):
                latexFile = os.path.join(root, file)
                command = ["latexindent", latexFile, "-w", "-s"]
                if latexindent_config:
                    command.append(f"-l={latexindent_config}")
                subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for pattern in ["**/*.bak0", "**/indent.log"]:
        for file in glob.glob(pattern, recursive=True):
            delete_file(file)

    logger.info("All .tex files indented and temp files deleted")
