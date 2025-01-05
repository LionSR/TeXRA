"""
Utilities module for the coauthor package.
Provides a collection of helper functions for file operations, image processing,
XML handling, text replacements, and other common tasks.
"""

from .file import (
    readFile,
    writeFile,
    appendFile,
    deleteFile,
    moveFile,
    findFile,
)

from .img import (
    getBase64EncodedImage,
    singlePagePdf2Png,
    multiPagePdf2Png,
    processPdfInput,
    countPdfPages,
)

from .xml import (
    extractTextFromTag,
    addCdataToTags,
    addCdataToTagsMultiple,
)

from .prompt import (
    getListOfFiles,
    renderPrompt,
    getXmlFormatFromFile,
    getXmlFormatFromFiles,
)

from .exec import executeCommand, truncateOutput

from .confirmation import wrapConfirmationPrompts, CONFIRMATION_PROMPT_PATTERNS

from .replacement import (
    ReplacementCategory,
    getAllReplacements,
    getReplacementsByCategory,
    applyReplacements,
    applyReplacementRegex,
)

from .repetition import checkForMassiveRepetition

__all__ = [
    # File operations
    "readFile",
    "writeFile",
    "appendFile",
    "deleteFile",
    "moveFile",
    "findFile",
    "getListOfFiles",
    # Image and PDF processing
    "getBase64EncodedImage",
    "singlePagePdf2Png",
    "multiPagePdf2Png",
    "processPdfInput",
    "countPdfPages",
    # XML handling
    "getXmlFormatFromFile",
    "getXmlFormatFromFiles",
    "extractTextFromTag",
    "addCdataToTags",
    "addCdataToTagsMultiple",
    # Text processing and replacements
    "ReplacementCategory",
    "getAllReplacements",
    "getReplacementsByCategory",
    "applyReplacements",
    "applyReplacementRegex",
    "checkForMassiveRepetition",
    # Prompts and confirmation
    "renderPrompt",
    "wrapConfirmationPrompts",
    "CONFIRMATION_PROMPT_PATTERNS",
    # Execution
    "executeCommand",
    "truncateOutput",
]
