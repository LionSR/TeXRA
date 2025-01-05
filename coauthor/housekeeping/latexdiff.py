import os
from datetime import datetime

from ..utils.file import delete_file, move_file, find_file
from ..logger import logger

from .constants import TEMP_EXTENSIONS


def run_pack_latexdiff_vc(inputFile: str, commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files into timestamped directory or remove them."""
    baseName = os.path.splitext(os.path.basename(inputFile))[0]
    input_dir = os.path.dirname(inputFile)
    output_folder = None if clean else os.path.join(input_dir, "Diffs", f"{datetime.now().strftime('%Y%m%d%H%M')}_{baseName}_{commitHash}")

    file_patterns = [f"{baseName}-diff{commitHash}"]
    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for ext in [".tex", ".pdf"]:
            filePath = find_file(input_dir, pattern, ext)
            if filePath:
                files_to_process.append(filePath)
                for temp_ext in TEMP_EXTENSIONS:
                    temp_file = os.path.splitext(filePath)[0] + temp_ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)

    if files_to_process:
        if clean:
            for filePath in files_to_process + files_to_delete:
                delete_file(filePath)
            logger.info("Cleanup finished")
        else:  # move files to output folder
            os.makedirs(output_folder, exist_ok=True)
            for filePath in files_to_process:
                move_file(filePath, output_folder)

            for filePath in files_to_delete:
                delete_file(filePath)

            logger.info(f"Files packed to: {output_folder}")
    else:
        logger.warning("No files found to process.")


def run_pack_latexdiff_vc_multiple(inputFiles: list[str], commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files for multiple input files."""
    for inputFile in inputFiles:
        run_pack_latexdiff_vc(inputFile, commitHash, clean)
