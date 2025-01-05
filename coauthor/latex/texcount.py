import os

from ..logger import logger

from ..utils.exec import execute_command


def get_texcount(filePaths: list[str] | str, merge: bool = False) -> str | None:
    """Run texcount on LaTeX files and return combined statistics output, optionally merging included files."""
    if not isinstance(filePaths, list):
        filePaths = [filePaths]

    all_outputs = []
    for filePath in filePaths:
        if not os.path.exists(filePath):
            logger.warning(f"Warning: File {filePath} does not exist.")
            continue

        if ".tex" not in filePath:
            logger.warning(f"Error: File {filePath} is not a LaTeX file. Skipping.")
            continue

        command = ["texcount"]
        if merge:
            command.append("-merge")
        command.append(filePath)

        success, stdout, stderr = execute_command(command, capture_output=True)
        if success:
            all_outputs.append(f"Tex Count Results for {filePath}:\n{stdout}")
        else:
            logger.error(f"Error getting tex count for {filePath}")
            logger.error(f"Stdout: {stdout}")
            logger.error(f"Stderr: {stderr}")

    if all_outputs:
        combined_output = "\n\n".join(all_outputs)
        logger.info(f"Combined Tex Count Results:\n{combined_output}")
        return combined_output
    return None


def get_texcountStats(inputFiles: str | list[str]) -> str | None:
    """Run texcount on LaTeX files and return formatted statistics with XML-style tags."""
    if isinstance(inputFiles, str):
        inputFiles = [inputFiles]

    texcountStats = get_texcount(inputFiles)
    return f"Tex Count Statistics:<texcount>\n{texcountStats}\n</texcount>\n\n" if texcountStats else None
