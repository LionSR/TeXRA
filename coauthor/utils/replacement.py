"""Utilities for managing text replacements in the codebase."""

import re
from dataclasses import dataclass


@dataclass
class ReplacementCategory:
    """A category of related text replacements."""

    name: str
    description: str
    patterns: dict[str, str]


# ===== LaTeX Content Formatting =====

# Common LaTeX equation spacing fixes
EQUATION_REPLACEMENTS = ReplacementCategory(
    name="equations",
    description="Fixes for LaTeX equation spacing and formatting",
    patterns={
        r"\n\n\begin{align}": r"\n\begin{align}",
        r"\end{align}\n\n": r"\end{align}\n",
        r"\n\n\begin{equation}": r"\n\begin{equation}",
        r"\end{equation}\n\n": r"\end{equation}\n",
    },
)

# Section spacing fixes
SECTION_REPLACEMENTS = ReplacementCategory(
    name="sections",
    description="Fixes for section spacing in LaTeX documents",
    patterns={
        r"\end{align}\n\section": r"\end{align}\n\n\n\section",
        r"\end{equation}\n\section": r"\end{equation}\n\n\n\section",
        r"\end{align}\n\subsection": r"\end{align}\n\n\n\subsection",
        r"\end{equation}\n\subsection": r"\end{equation}\n\n\n\subsection",
        r"\end{align}\n\paragraph": r"\end{align}\n\n\n\paragraph",
        r"\end{equation}\n\paragraph": r"\end{equation}\n\n\n\paragraph",
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

# Special character replacements
CHARACTER_REPLACEMENTS = ReplacementCategory(
    name="characters",
    description="Fixes for special characters and diacritics",
    patterns={
        "ansätze": r"ans{\"a}tze",
        "Rényi": r"R{\'e}nyi",
        "Schrödinger": r"Schr{\"o}dinger",
    },
)

# ===== XML/Structural Formatting =====

# XML structure fixes specifically for output processing
LATEX_XML_REPLACEMENTS = ReplacementCategory(
    name="latex_xml",
    description="Fixes specific to XML output processing",
    patterns={
        # Basic tag fixes
        r"\end{document>}": r"\end{document}",
        r"\end{figure>}": r"\end{figure}",
        r"\end{tikzpicture>}": r"\end{tikzpicture}",
        r"\end{revised_statement>}": "</revised_statement>",
        r"\end{scope>}": r"\end{scope}",
        r"\end{latex_document>}": "</latex_document>\n",
        r"\end{output>}": r"\end{output}",
        r"\end{response>}": r"\end{response}",
        r"\end{scratchpad>}": "</scratchpad>",
        r"\end{itemize>}": r"\end{itemize}",
        # LaTeX to XML conversions
        r"\end{scratchpad}": "</scratchpad>",
        r"\end\n": r"\end{document}\n",
        "</figure>\n": r"\end{figure}\n",
        r"\begin{latex_document}": "<latex_document>",
        # Scratchpad and latex_document handling
        "<scratchpad>\n<scratchpad>\n": "<scratchpad>\n",
        "<scratchpad>\n```latex\n": "<scratchpad>\n<latex_document>\n",
        "```\n</scratchpad>\n</latex_document>": "</latex_document>",
        "</latex_document>\n```\n</latex_document>": "</latex_document>\n",
        "</latex_document>\n</latex_document>": "</latex_document>\n",
        "</latex_document>\n\n</latex_document>": "</latex_document>\n",
        # Document nesting and structure
        r"\end{document}\n\n\<document name=": r"\end{document}\n</document>\n\<document name=",
        r"\end{document}\n\<document name=": r"\end{document}\n</document>\n\<document name=",
        r"\end{latex_document}\n</latex_document>": r"\end{document}\n</latex_document>",
        r"\end{document}\n</latex_documents>": r"\end{document}\n</document>\n</latex_documents>",
        r"\end{document}\n\n<document name": r"\end{document}\n</document>\n\n<document name",
        r"\end{document}\n<document name": r"\end{document}\n</document>\n<document name",
        r"\end{document}\n</rebuttal_package>": r"\end{document}\n</document>\n</rebuttal_package>",
        # Special cases
        r"{\today}\n\n[Previous": r"{\today}\n\n\begin{document}\n\makeheader[Previous",
        # Special cases for monologue handling
        "</monologue><monologue>": "</monologue>\n<monologue>",  # Add newline between monologues
    },
)

SCRATCHPAD_XML_REPLACEMENTS = ReplacementCategory(
    name="scratchpad_xml",
    description="Fixes for scratchpad XML processing",
    patterns={
        # Duplicate scratchpad tag fixes - remove redundant tags
        "<scratchpad><scratchpad>": "<scratchpad>",
        "<scratchpad> <scratchpad>": "<scratchpad>",
        "<scratchpad>\n<scratchpad>": "<scratchpad>",
        # Scratchpad to latex_document transitions - ensure proper nesting
        "<scratchpad>\n<latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "<scratchpad><latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "<scratchpad><cover_letter>": "<scratchpad>\n</scratchpad>\n<cover_letter>",
        "<scratchpad>\n<cover_letter>": "<scratchpad>\n</scratchpad>\n<cover_letter>",
        # Code block to latex_document conversions - handle markdown code blocks
        "<scratchpad>\n```latex\n<latex_document>": "<scratchpad>\n</scratchpad>\n<latex_document>",
        "</scratchpad>\n\n```latex": "</scratchpad>\n\n<latex_document>",
        "</scratchpad>\n    \n```latex": "</scratchpad>\n\n<latex_document>",
        "```\n</latex_document>": "</latex_document>",
        # Special LaTeX content handling
        r"</scratchpad>\n\section{": r"</scratchpad>\n<\latex_document>\n\section{",
        r"</scratchpad>\n\begin{document}": r"</scratchpad>\n<latex_document>\n\begin{document}",
        # Rebuttal package fixes
        "<rebuttal_package><scratchpad>\n\n<rebuttal_package><scratchpad>": "<rebuttal_package><scratchpad>",
    },
)

# ===== Style and Content Improvements =====

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
        '"exact"': r"``exact''",
    },
)

AUTO_CONFIRM_REPLACEMENTS = ReplacementCategory(
    name="autoConfirmation",
    description="Fixes for auto confirmation writing with regex patterns",
    patterns={
        # Match the entire confirmation message block and reformat
        r"<latex_code>\s*<monologue>\[Due to length limits,[^\n]*\n(.*?)</monologue>": r"<monologue>\[Due to length limits,\1</monologue>\n<latex_code>",
        # Handle case where latex_document tag precedes the monologue
        r"<latex_code>\s*<monologue>\[I apologize, but I notice this is a very long document,[^\n]*\n(.*?)</monologue>": r"<monologue>\[I apologize, but I notice this is a very long document\1</monologue><latex_code>",
        # Handle truncated request messages
        r"<latex_code>\s*(<monologue>\[Previous request was truncated due to length,[^\n]*\n(.*?)</monologue>)": r"\1",
    },
)


def get_all_replacements() -> dict[str, str]:
    """Get all replacement patterns combined into a single dictionary."""
    all_replacements: dict[str, str] = {}
    categories = [
        # LaTeX Content Formatting
        EQUATION_REPLACEMENTS,
        SECTION_REPLACEMENTS,
        TIKZ_REPLACEMENTS,
        CHARACTER_REPLACEMENTS,
        # XML/Structural Formatting
        LATEX_XML_REPLACEMENTS,
        SCRATCHPAD_XML_REPLACEMENTS,
        # Style and Content Improvements
        STYLE_REPLACEMENTS,
        # AUTO_CONFIRM_REPLACEMENTS is commented out as in original
    ]

    for category in categories:
        all_replacements.update(category.patterns)
    return all_replacements


def get_replacements_by_category(category_name: str) -> dict[str, str]:
    """Get replacement patterns for a specific category."""
    categories = {
        # LaTeX Content Formatting
        "equations": EQUATION_REPLACEMENTS,
        "sections": SECTION_REPLACEMENTS,
        "tikz": TIKZ_REPLACEMENTS,
        "characters": CHARACTER_REPLACEMENTS,
        # XML/Structural Formatting
        "latex_xml": LATEX_XML_REPLACEMENTS,
        "scratchpad_xml": SCRATCHPAD_XML_REPLACEMENTS,
        # Style and Content Improvements
        "style": STYLE_REPLACEMENTS,
        "autoConfirmation": AUTO_CONFIRM_REPLACEMENTS,
    }
    category = categories.get(category_name)
    return category.patterns if category else {}


def apply_replacements(text: str, replacements: dict[str, str]) -> str:
    """Apply a dictionary of replacements to the given text."""
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def apply_replacement_regex(text: str, replacements: dict[str, str], flags: int = 0) -> str:
    """Apply a dictionary of regex replacements to the given text."""
    for pattern, repl in replacements.items():
        text = re.sub(pattern, repl, text, flags=flags)
    return text
