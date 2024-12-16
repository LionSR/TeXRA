import os
import re
from typing import List, Optional

from ..logger import logger
from ..utils.file import read_file


def extract_figure_paths_from_latex(latex_file: str) -> list[str] | None:
    """Extract figure paths from a LaTeX file."""
    if not latex_file or not os.path.exists(latex_file):
        return None

    content = read_file(latex_file)
    if not content:
        return None

    # Regular expression to match \includegraphics commands
    pattern = r"\\includegraphics(?:\[.*?\])?\{(.*?)\}"
    matches = re.findall(pattern, content)

    figure_paths = []
    base_dir = os.path.dirname(latex_file)

    for path in matches:
        # Handle paths with and without extensions
        if not os.path.splitext(path)[1]:
            for ext in [".pdf", ".png", ".jpg", ".jpeg"]:
                full_path = os.path.join(base_dir, path + ext)
                if os.path.exists(full_path):
                    figure_paths.append(full_path)
                    break
        else:
            full_path = os.path.join(base_dir, path)
            if os.path.exists(full_path):
                figure_paths.append(full_path)

    if figure_paths:
        logger.info(f"Found {len(figure_paths)} figures in {latex_file}")
        return figure_paths
    return None
