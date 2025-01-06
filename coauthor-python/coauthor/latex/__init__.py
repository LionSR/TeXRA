"""
LaTeX module for the coauthor package.
Provides utilities for LaTeX document processing, including diff generation,
figure extraction, TikZ compilation, and text analysis.
"""

from .extract_figure import extract_figurePaths_from_latex
from .latexdiff import (
    process_tikzpicture_endings_diff,
    runLatexdiff,
    runLatexdiffBetweenRounds,
    runLatexdiffForRound,
    runLatexdiff_multiple,
    runLatexdiffvc,
    runLatexdiffvc_multiple,
)
from .latexindent import run_latexindent
from .text_connection import bestConnectionMethod
from .texcount import getTexcount, getTexcountStats
from .tikzpicture import compile_latex_to_pdf, extract_and_compile_tikzpictures_with_labels

__all__ = [
    # Document comparison and diffing
    "runLatexdiff",
    "runLatexdiff_multiple",
    "runLatexdiffForRound",
    "runLatexdiffBetweenRounds",
    "runLatexdiffvc",
    "runLatexdiffvc_multiple",
    "process_tikzpicture_endings_diff",
    # Document formatting and compilation
    "run_latexindent",
    "compile_latex_to_pdf",
    # Figure and TikZ handling
    "extract_figurePaths_from_latex",
    "extract_and_compile_tikzpictures_with_labels",
    # Text analysis and processing
    "getTexcount",
    "getTexcountStats",
    "bestConnectionMethod",
]
