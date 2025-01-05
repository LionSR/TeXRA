import subprocess

from ..logger import logger

from .file import writeFile


def truncateOutput(text: str | None, maxChars: int = 150) -> str | None:
    """Truncate text to maxChars by keeping the end portion."""
    if text and len(text) > maxChars:
        return "..." + text[-maxChars:]
    return text


def executeCommand(
    command: list[str], outputFile: str = "", encoding: str = "utf-8", captureOutput: bool = True
) -> tuple[bool, str | None, str | None]:
    """Execute external command with output handling, returns (success, stdout, stderr) or writes to file."""

    try:
        result = subprocess.run(command, text=True, capture_output=captureOutput, encoding=encoding)
        if outputFile:
            if result.returncode != 0:
                logger.error(f"\nCommand failed with return code {result.returncode}")
                return False, None, result.stderr.strip()
            writeFile(outputFile, result.stdout)
            logger.info("Command completed.\nOutput saved to " + outputFile)
            return True, None, None
        else:
            if result.returncode == 0:
                return True, truncateOutput(result.stdout.strip()), truncateOutput(result.stderr.strip())
            else:
                return False, truncateOutput(result.stdout.strip()), truncateOutput(result.stderr.strip())
    except subprocess.CalledProcessError as e:
        errorMessage = "Error running command:\n"
        if hasattr(e, "stderr") and e.stderr:
            errorMessage += f"\nStderr:\n{truncateOutput(e.stderr)}"
        logger.error("\n" + errorMessage)
        return False, None, errorMessage
