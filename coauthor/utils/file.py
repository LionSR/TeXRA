import os
import shutil

from ..logger import logger


def readFile(filePath: str, raise_warning: bool = True) -> str:
    """Read and return contents of a file, with optional warning for missing files."""
    if filePath is None:
        if raise_warning:
            logger.warning(f"File not provided: {filePath}")
        return ""
    elif not os.path.exists(filePath):
        if raise_warning:
            logger.warning(f"File not found: {filePath}")
        return ""
    with open(filePath, "r+", encoding="utf-8") as file:
        return file.read().strip()


def writeFile(filePath: str, content: str) -> None:
    """Write content to a file, creating it if it doesn't exist."""
    with open(filePath, "w", encoding="utf-8") as file:
        file.write(content)


def appendFile(filePath: str, content: str) -> None:
    """Append content to an existing file."""
    with open(filePath, "a", encoding="utf-8") as file:
        file.write(content)


def deleteFile(filePath: str) -> None:
    """Delete a file or directory, handling potential permission errors."""
    try:
        if os.path.isfile(filePath):
            os.remove(filePath)
            logger.info(f"Deleted file: {filePath}")
        elif os.path.isdir(filePath):
            shutil.rmtree(filePath)
            logger.info(f"Deleted dir: {filePath}")
    except PermissionError:
        logger.error(f"Cannot delete {filePath} - file in use or permission denied")
    except Exception as e:
        logger.error(f"Failed to delete {filePath}: {str(e)}")


def moveFile(source: str, destination: str) -> None:
    """Move a file from source to destination path."""
    shutil.move(source, destination)
    logger.info(f"Moved file: {source}")


def findFile(inputDir: str, pattern: str, ext: str | None = None) -> str | None:
    """Find first file matching pattern and optional extension in input directory."""
    search_dirs = [os.path.join(inputDir, "build"), inputDir]

    for dir in search_dirs:
        for file in os.listdir(dir):
            if pattern.lower() in file.lower():
                if ext is None or file.endswith(ext):
                    return os.path.join(dir, file)
    return None
