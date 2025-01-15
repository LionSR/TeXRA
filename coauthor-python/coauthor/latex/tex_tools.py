import os

from ..logger import logger
from ..utils.exec import executeCommand


def compile_latex_to_pdf(latexFile: str) -> bool:
    """Compile a LaTeX file to PDF using pdflatex."""
    outputDirectory = os.path.dirname(latexFile)
    command = ["pdflatex", "-interaction=nonstopmode", "-output-directory=" + outputDirectory, latexFile]

    try:
        success, stdout, stderr = executeCommand(command, captureOutput=True)
        if success:
            logger.info(f"Compiled {latexFile} successfully.")
            return True
        else:
            logger.error(f"Error compiling {latexFile}")
            return False
    except ValueError as e:
        logger.error(f"Error compiling {latexFile}: {str(e)}")
        return False
