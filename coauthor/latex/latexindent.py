import os
import subprocess
import glob

from ..logger import logger


def run_latexindent(file_path: str) -> bool:
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")
    command = ["latexindent", file_path, "-w", "-s"]
    if latexindent_config:
        command.append(f"-l={latexindent_config}")

    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        logger.info(f"Indented {file_path}")

        # Clean up backup files
        backup_files = glob.glob(f"{file_path}.bak[0-9]*") + glob.glob(f"{file_path}.bak")
        for backup_file in backup_files:
            try:
                os.remove(backup_file)
                logger.info(f"Removed backup file: {backup_file}")
            except OSError as e:
                logger.warning(f"Error removing backup file {backup_file}: {e}")

        # Remove indent.log if it exists
        indent_log = os.path.join(os.path.dirname(file_path), "indent.log")
        if os.path.exists(indent_log):
            try:
                os.remove(indent_log)
                logger.info("Removed indent.log")
            except OSError as e:
                logger.warning(f"Error removing indent.log: {e}")

        return True
    except subprocess.CalledProcessError:
        logger.error(f"Error indenting {file_path}")
        return False
