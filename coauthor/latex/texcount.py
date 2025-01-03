import os

from ..logger import logger

from ..utils.exec import execute_command


def get_texcount(file_paths: list[str] | str, merge: bool = False) -> str | None:
    """Run texcount on LaTeX files and return combined statistics output, optionally merging included files."""
    if not isinstance(file_paths, list):
        file_paths = [file_paths]

    all_outputs = []
    for file_path in file_paths:
        if not os.path.exists(file_path):
            logger.warning(f"Warning: File {file_path} does not exist.")
            continue

        if ".tex" not in file_path:
            logger.warning(f"Error: File {file_path} is not a LaTeX file. Skipping.")
            continue

        command = ["texcount"]
        if merge:
            command.append("-merge")
        command.append(file_path)

        success, stdout, stderr = execute_command(command, capture_output=True)
        if success:
            all_outputs.append(f"Tex Count Results for {file_path}:\n{stdout}")
        else:
            logger.error(f"Error getting tex count for {file_path}")
            logger.error(f"Stdout: {stdout}")
            logger.error(f"Stderr: {stderr}")

    if all_outputs:
        combined_output = "\n\n".join(all_outputs)
        logger.info(f"Combined Tex Count Results:\n{combined_output}")
        return combined_output
    return None


def get_texCountStats(inputFiles: str | list[str]) -> str | None:
    """Run texcount on LaTeX files and return formatted statistics with XML-style tags."""
    if isinstance(inputFiles, str):
        inputFiles = [inputFiles]
    texCountStats = get_texcount(inputFiles)
    return f"Tex Count Statistics:<texcount>\n{texCountStats}\n</texcount>\n\n" if texCountStats else None
