import os
import re

from ..logger import logger
from ..utils.file import read_file


def _parse_graphicspath(content: str) -> list[str]:
    r"""Parse \graphicspath commands supporting both single and multiple path formats.

    Handles both:
    \graphicspath{ {./images1/} }
    \graphicspath{ {./images1/}{./images2/} }
    """
    paths = []
    # Match both single and multiple path formats
    graphicspath_pattern = re.compile(r"\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}")
    # Pattern to extract individual paths from nested braces
    path_pattern = re.compile(r"\{([^{}]+)\}")

    for outer_match in graphicspath_pattern.finditer(content):
        outer_content = outer_match.group(1)
        for path_match in path_pattern.finditer(outer_content):
            path = path_match.group(1).strip()
            # Ensure path has trailing slash
            if path and not path.endswith("/"):
                path += "/"
            if path:
                paths.append(path)

    return paths


def extract_figure_paths_from_latex(latexFile: str) -> list[str] | None:
    r"""Extract absolute paths of figures referenced by \includegraphics commands in LaTeX file."""
    if not latexFile or not os.path.exists(latexFile):
        return None

    content = read_file(latexFile)
    if not content:
        return None

    base_dir = os.path.dirname(latexFile)
    graphicspaths = [base_dir]  # Start with the directory of the LaTeX file

    # Parse graphicspaths
    paths = _parse_graphicspath(content)
    for path in paths:
        normalized_path = os.path.normpath(os.path.join(base_dir, path.strip("/")))
        graphicspaths.append(normalized_path)
        logger.debug(f"Added graphicspath: {normalized_path}")

    # Regular expressions to match figure inclusion commands
    figure_patterns = [r"\\includegraphics(?:\[.*?\])?\{(.*?)\}", r"\\begin\{overpic\}(?:\[.*?\])?\{(.*?)\}"]

    figure_paths = []
    for pattern in figure_patterns:
        matches = re.findall(pattern, content)
        for path in matches:
            # Try each graphics path
            for graphics_path in graphicspaths:
                full_path_base = os.path.join(graphics_path, path)

                # Handle paths with and without extensions
                if not os.path.splitext(path)[1]:
                    for ext in [".pdf", ".png", ".jpg", ".jpeg"]:
                        full_path = full_path_base + ext
                        if os.path.exists(full_path):
                            figure_paths.append(full_path)
                            break
                else:
                    if os.path.exists(full_path_base):
                        figure_paths.append(full_path_base)
                        break

    if figure_paths:
        logger.info(f"Found {len(figure_paths)} figures in {latexFile}")
        return figure_paths
    return None
