import os
from datetime import datetime

from ..utils.file import delete_file, move_file, find_file
from ..logger import logger

from .constants import TEMP_EXTENSIONS


def run_pack_latexdiff_vc(inputFile: str, commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files into timestamped directory or remove them."""
    base_name = os.path.splitext(os.path.basename(inputFile))[0]
    input_dir = os.path.dirname(inputFile)
    output_folder = None if clean else os.path.join(input_dir, "Diffs", f"{datetime.now().strftime('%Y%m%d%H%M')}_{base_name}_{commitHash}")

    file_patterns = [f"{base_name}-diff{commitHash}"]
    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for ext in [".tex", ".pdf"]:
            file_path = find_file(input_dir, pattern, ext)
            if file_path:
                files_to_process.append(file_path)
                for temp_ext in TEMP_EXTENSIONS:
                    temp_file = os.path.splitext(file_path)[0] + temp_ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)

    if files_to_process:
        if clean:
            for file_path in files_to_process + files_to_delete:
                delete_file(file_path)
            logger.info("Cleanup finished")
        else:  # move files to output folder
            os.makedirs(output_folder, exist_ok=True)
            for file_path in files_to_process:
                move_file(file_path, output_folder)

            for file_path in files_to_delete:
                delete_file(file_path)

            logger.info(f"Files packed to: {output_folder}")
    else:
        logger.warning("No files found to process.")


def run_pack_latexdiff_vc_multiple(inputFiles: list[str], commitHash: str, clean: bool = False) -> None:
    """Pack or clean latexdiff-vc output files for multiple input files."""
    for inputFile in inputFiles:
        run_pack_latexdiff_vc(inputFile, commitHash, clean)
