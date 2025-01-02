import os

from ..logger import logger
from ..utils.exec import execute_command


def compile_latex_to_pdf(tex_file: str) -> bool:
    """Compile a LaTeX file to PDF using pdflatex."""
    output_directory = os.path.dirname(tex_file)
    command = ["pdflatex", "-interaction=nonstopmode", "-output-directory=" + output_directory, tex_file]

    try:
        success, stdout, stderr = execute_command(command, capture_output=True)
        if success:
            logger.info(f"Compiled {tex_file} successfully.")
            return True
        else:
            logger.error(f"Error compiling {tex_file}")
            return False
    except ValueError as e:
        logger.error(f"Error compiling {tex_file}: {str(e)}")
        return False
