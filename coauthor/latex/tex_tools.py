import os
import subprocess

from ..utils.file import write_file
from ..logger import logger


def run_external_command(
    command: list[str], output_file: str = "", encoding: str = "utf-8", capture_output: bool = True
) -> tuple[bool, str | None, str | None]:
    """Execute external command with output handling, returns (success, stdout, stderr) or writes to file."""

    def truncate_output(text: str | None, max_chars: int = 150) -> str | None:
        """Truncate text to max_chars by keeping the end portion."""
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


def compile_latex_to_pdf(tex_file: str) -> bool:
    """Compile a LaTeX file to PDF using pdflatex."""
    output_directory = os.path.dirname(tex_file)
    command = ["pdflatex", "-interaction=nonstopmode", "-output-directory=" + output_directory, tex_file]

    try:
        success, stdout, stderr = run_external_command(command, capture_output=True)
        if success:
            logger.info(f"Compiled {tex_file} successfully.")
            return True
        else:
            logger.error(f"Error compiling {tex_file}")
            return False
    except ValueError as e:
        logger.error(f"Error compiling {tex_file}: {str(e)}")
        return False
