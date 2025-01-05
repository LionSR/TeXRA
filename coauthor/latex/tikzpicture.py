import re
import os

from ..logger import logger

from ..utils.file import read_file, write_file
from ..utils.prompt import render_prompt

from .tex_tools import compile_latex_to_pdf


# maybe in the future move to a separate file in the agent path
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


def extract_tikzpictures_with_labels(latexFile: str) -> list[tuple[str, list[str]]]:
    """Extract TikZ pictures and their associated labels from LaTeX file, returns list of (label, pictures) tuples."""
    content = read_file(latexFile)

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


def extract_and_compile_tikzpictures_with_labels(latexFile: str) -> list[str]:
    """Extract and compile TikZ pictures from LaTeX file into standalone PDFs, returns PDF paths."""
    input_dir = os.path.dirname(latexFile)
    input_name = os.path.splitext(os.path.basename(latexFile))[0]
    build_dir = os.path.join(input_dir, "build", input_name)
    os.makedirs(build_dir, exist_ok=True)

    # Extract TikZ pictures
    logger.debug("Extracting TikZ pictures with labels...")
    labeled_tikzpictures = extract_tikzpictures_with_labels(latexFile)
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


def create_standalone_latex_with_labels(tikzpicture: str, label: str, build_dir: str, suffix: str | None = None) -> str:
    """Create a standalone LaTeX file containing a TikZ picture with labels."""
    standalone_content = render_prompt(TIKZ_TEMPLATE, {"tikzpicture": tikzpicture})
    filename = os.path.join(build_dir, f"{label}_{suffix}.tex" if suffix else f"{label}.tex")
    write_file(filename, standalone_content)

    return filename
