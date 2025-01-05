import os

from ..logger import logger
from ..utils.exec import execute_command


def compile_latex_to_pdf(latexFile: str) -> bool:
    """Compile a LaTeX file to PDF using pdflatex."""
    output_directory = os.path.dirname(latexFile)
    command = ["pdflatex", "-interaction=nonstopmode", "-output-directory=" + output_directory, latexFile]

    try:
        success, stdout, stderr = execute_command(command, capture_output=True)
        if success:
            logger.info(f"Compiled {latexFile} successfully.")
            return True
        else:
            logger.error(f"Error compiling {latexFile}")
            return False
    except ValueError as e:
        logger.error(f"Error compiling {latexFile}: {str(e)}")
        return False
