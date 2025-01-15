import os
from datetime import datetime

from ..utils.file import deleteFile, moveFile, findFile
from ..logger import logger

from .constants import TEMP_EXTENSIONS


def runPaclLatexdiffvc(inputFile: str, commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files into timestamped directory or remove them."""
    baseName = os.path.splitext(os.path.basename(inputFile))[0]
    inputDir = os.path.dirname(inputFile)
    outputFolder = None if clean else os.path.join(inputDir, "Diffs", f"{datetime.now().strftime('%Y%m%d%H%M')}_{baseName}_{commitHash}")

    file_patterns = [f"{baseName}-diff{commitHash}"]
    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for ext in [".tex", ".pdf"]:
            filePath = findFile(inputDir, pattern, ext)
            if filePath:
                files_to_process.append(filePath)
                for temp_ext in TEMP_EXTENSIONS:
                    temp_file = os.path.splitext(filePath)[0] + temp_ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)

    if files_to_process:
        if clean:
            for filePath in files_to_process + files_to_delete:
                deleteFile(filePath)
            logger.info("Cleanup finished")
        else:  # move files to output folder
            os.makedirs(outputFolder, exist_ok=True)
            for filePath in files_to_process:
                moveFile(filePath, outputFolder)

            for filePath in files_to_delete:
                deleteFile(filePath)

            logger.info(f"Files packed to: {outputFolder}")
    else:
        logger.warning("No files found to process.")


def runPaclLatexdiffvcMultiple(inputFiles: list[str], commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files for multiple input files."""
    for inputFile in inputFiles:
        runPaclLatexdiffvc(inputFile, commitHash, clean)
