import os
import shutil

from ..logger import logger
from ..utils.file import delete_file, move_file, find_file

from .constants import PACK_EXTENSIONS, TEMP_EXTENSIONS, HISTORY_DIR
from .utils import getAgent_first_name_chunk, get_file_patterns, get_folder_datetime


def run_pack_single(model: str, inputFile: str, agent: str, output_folder: str | None = None) -> None:
    """Pack LaTeX files and related outputs into timestamped history directory, cleaning temp files."""
    base_name = os.path.splitext(os.path.basename(inputFile))[0]
    input_dir = os.path.dirname(inputFile)

    agent_first_name_chunk = getAgent_first_name_chunk(agent)

    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)
    file_patterns.append(base_name)

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for ext in PACK_EXTENSIONS:
            file_path = find_file(input_dir, pattern, ext)
            if file_path:
                if file_path == inputFile or pattern == base_name:
                    copied_files.append(file_path)
                else:
                    moved_files.append(file_path)

    # this includes the original input file, f"{base}_{agent}_r{round}_{model}",
    # so even if no output file from llm is genereated, the output folder will still be created
    if moved_files or copied_files:
        now = get_folder_datetime(input_dir, file_patterns, PACK_EXTENSIONS)
        if output_folder is None:
            output_folder = os.path.join(input_dir, HISTORY_DIR, f"{now}_{base_name}_{agent}_{model}")
        os.makedirs(output_folder, exist_ok=True)
        for file_path in moved_files:
            move_file(file_path, output_folder)
        for file_path in copied_files:
            shutil.copy(file_path, output_folder)
            logger.info(f"Copied file: {file_path}")

        logger.info(f"Files packed to: {output_folder}")

    for pattern in file_patterns:
        for ext in TEMP_EXTENSIONS:
            file_path = find_file(input_dir, pattern, ext)
            if file_path and file_path != inputFile:
                delete_file(file_path)

    logger.info(f"Packing finished: {inputFile}.")
    return output_folder


def run_pack_multiple(model: str, inputFile: str, inputFiles: list[str], agent: str, outputNameOverride: str | None = None) -> None:
    """Pack multiple LaTeX files and their outputs into a single history directory."""
    # Initialize base_name and output_dir
    if outputNameOverride:
        base_name = os.path.splitext(os.path.basename(outputNameOverride))[0]
        output_dir = os.path.dirname(outputNameOverride)
    elif inputFile:
        base_name = os.path.splitext(os.path.basename(inputFile))[0]
        output_dir = os.path.dirname(inputFile)
    else:
        raise ValueError("Either inputFile or outputNameOverride must be provided")

    agent_first_name_chunk = getAgent_first_name_chunk(agent)
    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)

    # Add patterns for additional XML files
    additional_patterns = [f"{base_name}_{agent_first_name_chunk}_r0_{model}.xml", f"{base_name}_{agent_first_name_chunk}_r1_{model}.xml"]
    file_patterns.extend(additional_patterns)

    now = get_folder_datetime(output_dir, file_patterns, PACK_EXTENSIONS)
    common_output_folder = os.path.join(output_dir, HISTORY_DIR, f"{now}_{base_name}_multiple_{agent}_{model}")

    # Ensure the output folder exists
    os.makedirs(common_output_folder, exist_ok=True)

    # Pack input files
    for inputFile in inputFiles:
        logger.info(f"\nPacking files to: {common_output_folder}")
        run_pack_single(model, inputFile, agent, output_folder=common_output_folder)

    # Pack additional XML files
    for pattern in additional_patterns:
        file_path = os.path.join(output_dir, pattern)
        if os.path.exists(file_path):
            move_file(file_path, common_output_folder)

    logger.info(f"All files packed to: {common_output_folder}")
    return common_output_folder
