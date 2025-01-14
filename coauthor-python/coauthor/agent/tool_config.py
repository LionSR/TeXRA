"""Tool configuration data structures."""

from dataclasses import dataclass


@dataclass
class ToolConfig:
    """Configuration for tool usage and automation features."""

    usePrefillFromInput: bool = False
    autoExtractFigure: bool = False
    autoExtractTikzFigure: bool = False
    autoExtractTikzFigureReflect: bool = False
    attachTeXCount: bool = False
    autoConfirmation: bool = False
    printInputPrompt: bool = False
    useOpenRouter: bool = False
