import os
import shutil

from ..logger import logger
from ..utils.file import deleteFile, moveFile, findFile

from .constants import PACK_EXTENSIONS, TEMP_EXTENSIONS, HISTORY_DIR
from .utils import getAgent_first_name_chunk, get_file_patterns, get_folder_datetime


def runPackSingle(model: str, inputFile: str, agent: str, outputFolder: str | None = None) -> None:
    """Pack LaTeX files and related outputs into timestamped history directory, cleaning temp files."""
    baseName = os.path.splitext(os.path.basename(inputFile))[0]
    inputDir = os.path.dirname(inputFile)

    agent_first_name_chunk = getAgent_first_name_chunk(agent)

    file_patterns = get_file_patterns(baseName, model, agent_first_name_chunk)
    file_patterns.append(baseName)

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for ext in PACK_EXTENSIONS:
            filePath = findFile(inputDir, pattern, ext)
            if filePath:
                if filePath == inputFile or pattern == baseName:
                    copied_files.append(filePath)
                else:
                    moved_files.append(filePath)

    # this includes the original input file, f"{base}_{agent}_r{round}_{model}",
    # so even if no output file from llm is genereated, the output folder will still be created
    if moved_files or copied_files:
        now = get_folder_datetime(inputDir, file_patterns, PACK_EXTENSIONS)
        if outputFolder is None:
            outputFolder = os.path.join(inputDir, HISTORY_DIR, f"{now}_{baseName}_{agent}_{model}")
        os.makedirs(outputFolder, exist_ok=True)
        for filePath in moved_files:
            moveFile(filePath, outputFolder)
        for filePath in copied_files:
            shutil.copy(filePath, outputFolder)
            logger.info(f"Copied file: {filePath}")

        logger.info(f"Files packed to: {outputFolder}")

    for pattern in file_patterns:
        for ext in TEMP_EXTENSIONS:
            filePath = findFile(inputDir, pattern, ext)
            if filePath and filePath != inputFile:
                deleteFile(filePath)

    logger.info(f"Packing finished: {inputFile}.")
    return outputFolder


def runPackMultiple(model: str, inputFile: str, inputFiles: list[str], agent: str, outputNameOverride: str | None = None) -> None:
    """Pack multiple LaTeX files and their outputs into a single history directory."""
    # Initialize baseName and output_dir
    if outputNameOverride:
        baseName = os.path.splitext(os.path.basename(outputNameOverride))[0]
        output_dir = os.path.dirname(outputNameOverride)
    elif inputFile:
        baseName = os.path.splitext(os.path.basename(inputFile))[0]
        output_dir = os.path.dirname(inputFile)
    else:
        raise ValueError("Either inputFile or outputNameOverride must be provided")

    agent_first_name_chunk = getAgent_first_name_chunk(agent)
    file_patterns = get_file_patterns(baseName, model, agent_first_name_chunk)

    # Add patterns for additional XML files
    additional_patterns = [f"{baseName}_{agent_first_name_chunk}_r0_{model}.xml", f"{baseName}_{agent_first_name_chunk}_r1_{model}.xml"]
    file_patterns.extend(additional_patterns)

    now = get_folder_datetime(output_dir, file_patterns, PACK_EXTENSIONS)
    commonOutputFolder = os.path.join(output_dir, HISTORY_DIR, f"{now}_{baseName}_multiple_{agent}_{model}")

    # Ensure the output folder exists
    os.makedirs(commonOutputFolder, exist_ok=True)

    # Pack input files
    for inputFile in inputFiles:
        logger.info(f"\nPacking files to: {commonOutputFolder}")
        runPackSingle(model, inputFile, agent, outputFolder=commonOutputFolder)

    # Pack additional XML files
    for pattern in additional_patterns:
        filePath = os.path.join(output_dir, pattern)
        if os.path.exists(filePath):
            moveFile(filePath, commonOutputFolder)

    logger.info(f"All files packed to: {commonOutputFolder}")
    return commonOutputFolder
