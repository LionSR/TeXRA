"""
Housekeeping module for the coauthor package.
Provides utilities for cleaning, packing, and maintaining LaTeX files and build artifacts.
"""

from .constants import *
from .utils import *
from .clean import runCleanSingle, runCleanMultiple, runCleanBuild, runCleanOutput
from .pack import runPackSingle, runPackMultiple
from .indent import runIndentTex
from .latexdiff import runPaclLatexdiffvc, runPaclLatexdiffvcMultiple

__all__ = [
    # Cleaning operations
    "runCleanSingle",
    "runCleanMultiple",
    "runCleanBuild",
    "runCleanOutput",
    # Packing operations
    "runPackSingle",
    "runPackMultiple",
    "runPaclLatexdiffvc",
    "runPaclLatexdiffvcMultiple",
    # Formatting operations
    "runIndentTex",
]
