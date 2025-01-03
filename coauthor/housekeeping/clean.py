import os
import glob

from ..logger import logger
from ..utils import delete_file

from .constants import EXCLUDED_DIRS, TEMP_EXTENSIONS, PACK_EXTENSIONS, MODELS
from .utils import getAgent_first_name_chunk, get_file_patterns


def run_clean_single(model: str, inputFile: str, agent: str) -> None:
    """Clean temporary and packed files for a single LaTeX file based on model and agent."""
    base_name = os.path.splitext(os.path.basename(inputFile))[0]
    input_dir = os.path.dirname(inputFile)

    agent_first_name_chunk = getAgent_first_name_chunk(agent)
    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)
    file_patterns.extend([f"{base_name}_{agent_first_name_chunk}_r0_{model}_thinking", f"{base_name}_{agent_first_name_chunk}_r1_{model}_thinking"])

    extensions = TEMP_EXTENSIONS + PACK_EXTENSIONS

    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    delete_file(file_path)

    logger.info(f"Cleanup finished: {inputFile}.")


def run_clean_multiple(model: str, inputFile: str, inputFiles: list[str], agent: str) -> None:
    """Clean temporary and packed files for multiple LaTeX files based on model and agent."""
    run_clean_single(model, inputFile, agent)
    for f in inputFiles:
        run_clean_single(model, f, agent)
    logger.info("Multi-file cleanup finished")


def run_clean_build() -> None:
    """Recursively clean all build directories while respecting excluded directories."""

    def clean_build_dir(directory):
        build_dir = os.path.join(directory, "build")
        if os.path.isdir(build_dir):
            for item in os.listdir(build_dir):
                file_path = os.path.join(build_dir, item)
                delete_file(file_path)

    clean_build_dir(".")

    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED_DIRS]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            clean_build_dir(subdir)

    logger.info("All specified files deleted")


def run_clean_output() -> None:
    """Clean all output files matching specified patterns and extensions."""
    patterns = [f"*_{model}*.tex" for model in MODELS]
    patterns_build = [f"*/build/*_{model}*" for model in MODELS]

    files_to_delete = []

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED_DIRS]

        for pattern in patterns:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern)))

        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    for file in set(files_to_delete):
        try:
            if os.path.exists(file):
                delete_file(file)
            else:
                logger.warning(f"Not found: {file}")
        except OSError as e:
            logger.error(f"Failed to delete {file}: {e}")

    logger.info("Cleanup finished")
