import os

from ..logger import logger

from ..utils.exec import execute_command


def get_tex_count(file_paths: list[str] | str, merge: bool = False) -> str | None:
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


def get_tex_count_stats(input_files: str | list[str]) -> str | None:
    """Run texcount on LaTeX files and return formatted statistics with XML-style tags."""
    if isinstance(input_files, str):
        input_files = [input_files]
    tex_count_stats = get_tex_count(input_files)
    return f"Tex Count Statistics:<tex_count>\n{tex_count_stats}\n</tex_count>\n\n" if tex_count_stats else None
