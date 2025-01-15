import os
import glob

from ..logger import logger
from ..utils import deleteFile

from .constants import EXCLUDED_DIRS, TEMP_EXTENSIONS, PACK_EXTENSIONS, MODELS
from .utils import getAgent_first_name_chunk, get_file_patterns


def runCleanSingle(model: str, inputFile: str, agent: str) -> None:
    """Clean temporary and packed files for a single LaTeX file based on model and agent."""
    baseName = os.path.splitext(os.path.basename(inputFile))[0]
    inputDir = os.path.dirname(inputFile)

    agent_first_name_chunk = getAgent_first_name_chunk(agent)
    file_patterns = get_file_patterns(baseName, model, agent_first_name_chunk)
    file_patterns.extend([f"{baseName}_{agent_first_name_chunk}_r0_{model}_thinking", f"{baseName}_{agent_first_name_chunk}_r1_{model}_thinking"])

    extensions = TEMP_EXTENSIONS + PACK_EXTENSIONS

    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(inputDir, "build"), inputDir]:
                filePath = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(filePath):
                    deleteFile(filePath)

    logger.info(f"Cleanup finished: {inputFile}.")


def runCleanMultiple(model: str, inputFile: str, inputFiles: list[str], agent: str) -> None:
    """Clean temporary and packed files for multiple LaTeX files based on model and agent."""
    runCleanSingle(model, inputFile, agent)
    for f in inputFiles:
        runCleanSingle(model, f, agent)
    logger.info("Multi-file cleanup finished")


def runCleanBuild() -> None:
    """Recursively clean all build directories while respecting excluded directories."""

    def clean_buildDir(directory):
        buildDir = os.path.join(directory, "build")
        if os.path.isdir(buildDir):
            for item in os.listdir(buildDir):
                filePath = os.path.join(buildDir, item)
                deleteFile(filePath)

    clean_buildDir(".")

    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED_DIRS]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            clean_buildDir(subdir)

    logger.info("All specified files deleted")


def runCleanOutput() -> None:
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
                deleteFile(file)
            else:
                logger.warning(f"Not found: {file}")
        except OSError as e:
            logger.error(f"Failed to delete {file}: {e}")

    logger.info("Cleanup finished")
