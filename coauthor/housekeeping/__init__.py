"""
Housekeeping module for the coauthor package.
Provides utilities for cleaning, packing, and maintaining LaTeX files and build artifacts.
"""

from .constants import *
from .utils import *
from .clean import run_clean_single, run_clean_multiple, run_clean_build, run_clean_output
from .pack import run_pack_single, run_pack_multiple
from .indent import run_indent_tex
from .latexdiff import run_pack_latexdiff_vc, run_pack_latexdiff_vc_multiple

__all__ = [
    # Cleaning operations
    "run_clean_single",
    "run_clean_multiple",
    "run_clean_build",
    "run_clean_output",
    # Packing operations
    "run_pack_single",
    "run_pack_multiple",
    "run_pack_latexdiff_vc",
    "run_pack_latexdiff_vc_multiple",
    # Formatting operations
    "run_indent_tex",
]
