import subprocess

from ..logger import logger
from .file import write_file


def truncate_output(text: str | None, max_chars: int = 150) -> str | None:
    """Truncate text to max_chars by keeping the end portion."""
    if text and len(text) > max_chars:
        return "..." + text[-max_chars:]
    return text


def execute_command(
    command: list[str], outputFile: str = "", encoding: str = "utf-8", capture_output: bool = True
) -> tuple[bool, str | None, str | None]:
    """Execute external command with output handling, returns (success, stdout, stderr) or writes to file."""

    try:
        result = subprocess.run(command, text=True, capture_output=capture_output, encoding=encoding)
        if outputFile:
            if result.returncode != 0:
                logger.error(f"\nCommand failed with return code {result.returncode}")
                return False, None, result.stderr.strip()
            write_file(outputFile, result.stdout)
            logger.info("Command completed.\nOutput saved to " + outputFile)
            return True, None, None
        else:
            if result.returncode == 0:
                return True, truncate_output(result.stdout.strip()), truncate_output(result.stderr.strip())
            else:
                return False, truncate_output(result.stdout.strip()), truncate_output(result.stderr.strip())
    except subprocess.CalledProcessError as e:
        error_message = "Error running command:\n"
        if hasattr(e, "stderr") and e.stderr:
            error_message += f"\nStderr:\n{truncate_output(e.stderr)}"
        logger.error("\n" + error_message)
        return False, None, error_message
