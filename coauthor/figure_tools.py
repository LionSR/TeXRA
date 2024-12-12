import re
import os
from typing import List, Tuple, Optional

from .file_utils import read_file, write_file
from .logging_utils import logger
from .prompt_utils import get_list_of_files, render_prompt
from .tex_tools import compile_latex_to_pdf

# maybe in the future move to a separate file
TIKZ_TEMPLATE = r"""
\documentclass[tikz,border=10pt]{standalone}
\usepackage{tikz}
\usepackage{pgfplots}
\usetikzlibrary{positioning}
\usetikzlibrary{patterns}
\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}
\usetikzlibrary{shapes, arrows}

\begin{document}
{{ tikzpicture }}
\end{document}
"""


def extract_figure_paths_from_latex(latex_file: str) -> List[str]:
    """Extract figure paths from LaTeX file, returns list of paths"""
    figure_paths = []
    latex_dir = os.path.dirname(latex_file)
    graphicspaths = [latex_dir]  # Start with the directory of the LaTeX file

    # Regular expressions to match figure inclusion commands and graphicspath
    figure_patterns = [re.compile(r"\\includegraphics(?:\[.*?\])?\{(.+?)\}"), re.compile(r"\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}")]
    graphicspath_pattern = re.compile(r"\\graphicspath\s*\{(.+?)\}")

    try:
        content = read_file(latex_file)

        # Find all graphicspaths
        graphicspath_matches = graphicspath_pattern.findall(content)
        logger.debug(f"Graphicspath matches: {graphicspath_matches}")

        for match in graphicspath_matches:
            paths = [match.strip("{}")]  # Remove outer braces
            logger.debug(f"Paths found in graphicspath: {paths}")
            for path in paths:
                normalized_path = os.path.normpath(os.path.join(latex_dir, path.strip("/")))
                graphicspaths.append(normalized_path)
                logger.debug(f"Added graphicspath: {normalized_path}")

        # Debug print to check graphicspaths
        logger.debug(f"Graphicspaths: {graphicspaths}")

        # Find all matches in the content for both patterns
        for pattern in figure_patterns:
            matches = pattern.findall(content)
            for match in matches:
                for base_path in graphicspaths:
                    norm_path = os.path.normpath(os.path.join(base_path, match))
                    if os.path.exists(norm_path):
                        rel_path = os.path.relpath(norm_path, start=latex_dir)
                        figure_paths.append(rel_path)
                        break

    except FileNotFoundError:
        logger.error(f"File '{latex_file}' not found.")
    except Exception as e:
        logger.error(f"An error occurred: {str(e)}")

    logger.debug("Found figures: " + get_list_of_files(figure_paths))
    return figure_paths


def extract_tikzpictures_with_labels(latex_file: str) -> List[Tuple[str, List[str]]]:
    content = read_file(latex_file)

    # Regular expression to match entire figure environments with labels and tikzpicture environments
    figure_pattern = re.compile(r"(\\begin{figure}.*?\\label\{.*?\}.*?\\end{figure})", re.DOTALL)
    tikz_pattern = re.compile(r"\\begin{tikzpicture}.*?\\end{tikzpicture}", re.DOTALL)

    labeled_tikzpictures = []
    for figure in figure_pattern.findall(content):
        label_match = re.search(r"\\label\{(.*?)\}", figure)
        if label_match:
            label = label_match.group(1)
            tikz_matches = tikz_pattern.findall(figure)
            if tikz_matches:
                labeled_tikzpictures.append((label, tikz_matches))

    return labeled_tikzpictures


def create_standalone_latex_with_labels(tikzpicture: str, label: str, build_dir: str, suffix: Optional[str] = None) -> str:
    standalone_content = render_prompt(TIKZ_TEMPLATE, {"tikzpicture": tikzpicture})
    filename = os.path.join(build_dir, f"{label}_{suffix}.tex" if suffix else f"{label}.tex")
    write_file(filename, standalone_content)

    return filename


def extract_and_compile_tikzpictures_with_labels(latex_file: str) -> List[str]:
    """Extract and compile TikZ pictures, returns list of PDF paths"""
    input_dir = os.path.dirname(latex_file)
    input_name = os.path.splitext(os.path.basename(latex_file))[0]
    build_dir = os.path.join(input_dir, "build", input_name)
    os.makedirs(build_dir, exist_ok=True)

    # Extract TikZ pictures
    logger.debug("Extracting TikZ pictures with labels...")
    labeled_tikzpictures = extract_tikzpictures_with_labels(latex_file)
    logger.debug(f"Found {len(labeled_tikzpictures)} labeled TikZ pictures.")

    compiled_files = []
    for label, tikzpictures in labeled_tikzpictures:
        # Handle multiple TikZ pictures with same label by adding a,b,c suffixes
        suffixes = [chr(97 + i) if len(tikzpictures) > 1 else None for i in range(len(tikzpictures))]

        for tikzpicture, suffix in zip(tikzpictures, suffixes):
            # Create and compile standalone LaTeX file
            tex_file = create_standalone_latex_with_labels(tikzpicture, label, build_dir, suffix)
            compile_latex_to_pdf(tex_file)
            pdf_file = f"{os.path.splitext(tex_file)[0]}.pdf"
            compiled_files.append(pdf_file)

            # Clean up auxiliary files
            for aux_file in [f"{os.path.splitext(tex_file)[0]}{ext}" for ext in (".aux", ".log")]:
                if os.path.exists(aux_file):
                    os.remove(aux_file)

    return compiled_files
