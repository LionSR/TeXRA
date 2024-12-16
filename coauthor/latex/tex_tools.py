import subprocess

from ..utils.file import write_file
from ..logger import logger


def run_external_command(
    command: list[str], output_file: str = "", encoding: str = "utf-8", capture_output: bool = True
) -> tuple[bool, str | None, str | None]:
    """Run an external command and handle its output.

    Args:
        command: List containing the command and its arguments
        output_file: Path to the output file (if any)
        encoding: Encoding to use for file operations
        capture_output: Whether to capture and return the command output

    Returns:
        Tuple[bool, Optional[str], Optional[str]]: (success_flag, output_message, error_message)
    """
    logger.info("\nRunning command: " + " ".join(command))

    def truncate_output(text, max_chars=150):
        if text and len(text) > max_chars:
            return "..." + text[-max_chars:]
        return text

    try:
        result = subprocess.run(command, text=True, capture_output=capture_output, encoding=encoding)
        if output_file:
            if result.returncode != 0:
                logger.error(f"\nCommand failed with return code {result.returncode}")
                return False, None, result.stderr.strip()
            write_file(output_file, result.stdout)
            logger.info("Command completed.\nOutput saved to " + output_file)
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
