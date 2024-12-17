import os
import shutil

from ..logger import logger


def read_file(file_path: str, raise_warning: bool = True) -> str:
    """Read and return contents of a file, with optional warning for missing files."""
    if file_path is None:
        if raise_warning:
            logger.warning(f"File not provided: {file_path}")
        return ""
    elif not os.path.exists(file_path):
        if raise_warning:
            logger.warning(f"File not found: {file_path}")
        return ""
    with open(file_path, "r+", encoding="utf-8") as file:
        return file.read().strip()


def write_file(file_path: str, content: str) -> None:
    """Write content to a file, creating it if it doesn't exist."""
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)


def append_file(file_path: str, content: str) -> None:
    """Append content to an existing file."""
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(content)


def write_to_output_file(file_exists: bool, best_connector: str, new_response: str, output_file: str) -> bool:
    """Write or append content to output file and return updated file existence status."""
    if not file_exists:
        logger.debug(f"Creating new file: {output_file}")
        write_file(output_file, new_response)
        file_exists = True
    else:
        logger.debug(f"Appending to existing file: {output_file}")
        append_file(output_file, best_connector + new_response)

    return file_exists


def delete_file(file_path: str) -> None:
    """Delete a file or directory, handling potential permission errors."""
    try:
        if os.path.isfile(file_path):
            os.remove(file_path)
            logger.info(f"Deleted file: {file_path}")
        elif os.path.isdir(file_path):
            shutil.rmtree(file_path)
            logger.info(f"Deleted dir: {file_path}")
    except PermissionError:
        logger.error(f"Cannot delete {file_path} - file in use or permission denied")
    except Exception as e:
        logger.error(f"Failed to delete {file_path}: {str(e)}")


def move_file(source: str, destination: str) -> None:
    """Move a file from source to destination path."""
    shutil.move(source, destination)
    logger.info(f"Moved file: {source}")


def find_file(input_dir: str, pattern: str, ext: str | None = None) -> str | None:
    """Find first file matching pattern and optional extension in input directory."""
    search_dirs = [os.path.join(input_dir, "build"), input_dir]

    for dir in search_dirs:
        for file in os.listdir(dir):
            if pattern.lower() in file.lower():
                if ext is None or file.endswith(ext):
                    return os.path.join(dir, file)
    return None
