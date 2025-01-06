import os
import subprocess
import glob

from ..logger import logger


def run_latexindent(filePath: str) -> bool:
    """Run latexindent on a LaTeX file and clean up backup files."""
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")
    command = ["latexindent", filePath, "-w", "-s"]
    if latexindent_config:
        command.append(f"-l={latexindent_config}")

    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        logger.info(f"Indented {filePath}")

        # Clean up backup files
        backup_files = glob.glob(f"{filePath}.bak[0-9]*") + glob.glob(f"{filePath}.bak")
        for backup_file in backup_files:
            try:
                os.remove(backup_file)
                logger.info(f"Removed backup file: {backup_file}")
            except OSError as e:
                logger.warning(f"Error removing backup file {backup_file}: {e}")

        # Remove indent.log if it exists
        indent_log = os.path.join(os.path.dirname(filePath), "indent.log")
        if os.path.exists(indent_log):
            try:
                os.remove(indent_log)
                logger.info("Removed indent.log")
            except OSError as e:
                logger.warning(f"Error removing indent.log: {e}")

        return True
    except subprocess.CalledProcessError:
        logger.error(f"Error indenting {filePath}")
        return False
