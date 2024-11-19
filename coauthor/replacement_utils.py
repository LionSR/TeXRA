"""Utilities for managing text replacements in the codebase.

This module centralizes the management of text replacement patterns used throughout
the application for cleaning and normalizing text content.
"""

from typing import Dict, Optional
from dataclasses import dataclass
import re


@dataclass
class ReplacementCategory:
    """A category of related text replacements."""

    name: str
    description: str
    patterns: Dict[str, str]


# Common LaTeX equation spacing fixes
EQUATION_REPLACEMENTS = ReplacementCategory(
    name="equations",
    description="Fixes for LaTeX equation spacing and formatting",
    patterns={
        "\n\n\\begin{align}": "\n\\begin{align}",
        "\\end{align}\n\n": "\\end{align}\n",
        "\n\n\\begin{equation}": "\n\\begin{equation}",
        "\\end{equation}\n\n": "\\end{equation}\n",
    },
)

# Section spacing fixes
SECTION_REPLACEMENTS = ReplacementCategory(
    name="sections",
    description="Fixes for section spacing in LaTeX documents",
    patterns={
        "\\end{align}\n\\section": "\\end{align}\n\n\n\\section",
        "\\end{equation}\n\\section": "\\end{equation}\n\n\n\\section",
        "\\end{align}\n\\subsection": "\\end{align}\n\n\n\\subsection",
        "\\end{equation}\n\\subsection": "\\end{equation}\n\n\n\\subsection",
        "\\end{align}\n\\paragraph": "\\end{align}\n\n\n\\paragraph",
        "\\end{equation}\n\\paragraph": "\\end{equation}\n\n\n\\paragraph",
    },
)

# Special character replacements
CHARACTER_REPLACEMENTS = ReplacementCategory(
    name="characters",
    description="Fixes for special characters and diacritics",
    patterns={
        "ansätze": 'ans{\\"a}tze',
        "Rényi": "R{\\'e}nyi",
        "Schrödinger": 'Schr{\\"o}dinger',
    },
)

# Style improvements
STYLE_REPLACEMENTS = ReplacementCategory(
    name="style",
    description="Style improvements and word choice fixes",
    patterns={
        "delve": "discuss",
        "delving into": "discussing",
        "It's important to note": "Note that",
        "our exploration": "our discussion",
        "embark": "start",
        "realm": "area",
        "intricate": "complex",
    },
)


# XML structure fixes specifically for output processing
LATEX_XML_REPLACEMENTS = ReplacementCategory(
    name="latex_xml",
    description="Fixes specific to XML output processing",
    patterns={
        "\\end{document>": "\\end{document}",
        "\\end{figure>": "\\end{figure}",
        "\\end{tikzpicture>": "\\end{tikzpicture}",
        "\\end{revised_statement>": "</revised_statement>",
        "\\end{scope>": "\\end{scope}",
        "\\end{latex_document>": "</latex_document>\n",
        "\\end{scratchpad}": "</scratchpad>",
        "\\end\n": "\\end{document}\n",
        "\\end{response>": "\\end{response}",
        "</figure>\n": "\\end{figure}\n",
        "<scratchpad>\n<scratchpad>\n": "<scratchpad>\n",
        "\\end{document}\n\n\\<document name=": "\\end{document}\n</document>\n\\<document name=",
        "\\end{document}\n\\<document name=": "\\end{document}\n</document>\n\\<document name=",
        "\\end{latex_document}\n</latex_document>": "\\end{document}\n</latex_document>",
        "</latex_document>\n```\n</latex_document>": "</latex_document>\n",
        "\\begin{latex_document}": "<latex_document>",
        "\\end{document}\n</latex_documents>": "\\end{document}\n</document>\n</latex_documents>",
        "\\end{document}\n\n<document name": "\\end{document}\n</document>\n\n<document name",
        "\\end{document}\n<document name": "\\end{document}\n</document>\n<document name",
        "</latex_document>\n</latex_document>": "</latex_document>\n",
        "</latex_document>\n\n</latex_document>": "</latex_document>\n",
        "{\\today}\n\n[Previous": "{\\today}\n\n\\begin{document}\n\\makeheader[Previous",
    },
)

# TikZ picture fixes
TIKZ_REPLACEMENTS = ReplacementCategory(
    name="tikz",
    description="Fixes for TikZ picture formatting and structure",
    patterns={
        r"(?P<indent>[\t ]*)}\s*\\end{tikzpicture};\s*\\end{tikzpicture}": r"\g<indent>\\end{tikzpicture}\n\g<indent>};\n\g<indent>\\end{tikzpicture}",
        r"\\end\{document\}\s*\\chapter": r"\\chapter",
        r"\\end\{document\}\s*\\addcontentsline": r"\\addcontentsline",
        r"\}(\s*)\\end\{tikzpicture\};": r"};\1\\end{tikzpicture}",
        r"\}(\s*)\\end\{tikzpicture\}\\DIFaddendFL ;": r"\1\\end{tikzpicture}};\\DIFaddendFL",
    },
)

SCRATCHPAD_XML_REPLACEMENTS = ReplacementCategory(
    name="scratchpad_xml",
    description="Fixes for scratchpad XML processing",
    patterns={
        "<scratchpad><scratchpad>": "<scratchpad>",
        "<scratchpad> <scratchpad>": "<scratchpad>",
        "<scratchpad>\n<scratchpad>": "<scratchpad>",
        "<scratchpad>\n<latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "<scratchpad><latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "<scratchpad><cover_letter>": "<scratchpad>\n</scratchpad>\n<cover_letter>",
        "<scratchpad>\n<cover_letter>": "<scratchpad>\n</scratchpad>\n<cover_letter>",
        "<scratchpad>\n```latex\n<latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "</scratchpad>\n\\section{": "</scratchpad>\n<\\latex_document>\n\\section{",
        "<rebuttal_letter><scratchpad>\n\n<rebuttal_letter><scratchpad>": "<rebuttal_letter><scratchpad>",
        r"\end{scratchpad>": "</scratchpad>",
    },
)


def get_all_replacements() -> Dict[str, str]:
    """Get all replacement patterns combined into a single dictionary."""
    all_replacements: Dict[str, str] = {}
    categories = [
        # STYLE CHOICES
        EQUATION_REPLACEMENTS,
        SECTION_REPLACEMENTS,
        CHARACTER_REPLACEMENTS,
        STYLE_REPLACEMENTS,
        # FORMAT
        LATEX_XML_REPLACEMENTS,
        TIKZ_REPLACEMENTS,
    ]

    for category in categories:
        all_replacements.update(category.patterns)

    return all_replacements


def get_replacements_by_category(category_name: str) -> Optional[Dict[str, str]]:
    """Get replacement patterns for a specific category.

    Args:
        category_name: Name of the replacement category to retrieve

    Returns:
        Dictionary of replacement patterns or None if category not found
    """
    categories = {
        "equations": EQUATION_REPLACEMENTS,
        "sections": SECTION_REPLACEMENTS,
        "characters": CHARACTER_REPLACEMENTS,
        "style": STYLE_REPLACEMENTS,
        "latex_xml": LATEX_XML_REPLACEMENTS,
        "tikz": TIKZ_REPLACEMENTS,
        "scratchpad_xml": SCRATCHPAD_XML_REPLACEMENTS,
    }

    category = categories.get(category_name)
    return category.patterns if category else None


def apply_replacements(text: str, replacements: Dict[str, str]) -> str:
    """Apply a dictionary of replacements to the given text.

    Args:
        text: Text to process
        replacements: Dictionary of replacement patterns

    Returns:
        Processed text with all replacements applied
    """
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def apply_replacement_regex(text: str, replacements: Dict[str, str], flags: int = 0) -> str:
    """Apply a dictionary of regex replacements to the given text.

    Args:
        text: Text to process
        replacements: Dictionary of regex patterns and their replacements
        flags: Optional regex flags (e.g., re.DOTALL)

    Returns:
        Processed text with all regex replacements applied
    """
    for pattern, replacement in replacements.items():
        text = re.sub(pattern, replacement, text, flags=flags)
    return text
