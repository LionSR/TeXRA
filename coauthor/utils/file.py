import os
import shutil

from ..logger import logger


def read_file(file_path: str, raise_warning: bool = True) -> str:
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
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)


def append_file(file_path: str, content: str) -> None:
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(content)


def write_to_output_file(file_exists: bool, best_connector: str, new_response: str, output_file: str) -> bool:
    if not file_exists:
        logger.debug(f"Creating new file: {output_file}")
        write_file(output_file, new_response)
        file_exists = True
    else:
        logger.debug(f"Appending to existing file: {output_file}")
        append_file(output_file, best_connector + new_response)

    return file_exists


def delete_file(file_path):
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


def move_file(source, destination):
    shutil.move(source, destination)
    logger.info(f"Moved file: {source}")


def find_file(input_dir, pattern, ext=None):
    search_dirs = [os.path.join(input_dir, "build"), input_dir]
    if ext:
        file_name = f"{pattern}{ext}"
        for search_dir in search_dirs:
            file_path = os.path.join(search_dir, file_name)
            if os.path.exists(file_path):
                return file_path
    else:
        for search_dir in search_dirs:
            for file in os.listdir(search_dir):
                if file.startswith(pattern):
                    return os.path.join(search_dir, file)
    return None
