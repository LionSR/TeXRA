"""Tool configuration data structures."""

from dataclasses import dataclass


@dataclass
class ToolConfig:
    """Configuration for tool usage and automation features."""

    usePrefillFromInput: bool = False
    autoExtractFigure: bool = False
    autoExtractTikzFigure: bool = False
    autoExtractTikzFigureReflect: bool = False
    includeTexCount: bool = False
    autoConfirmation: bool = False
    printInputPrompt: bool = False

    @classmethod
    def from_dict(cls, config_dict: dict[str, bool]) -> "ToolConfig":
        """Create a ToolConfig from a dictionary."""
        return cls(
            usePrefillFromInput=config_dict.get("usePrefillFromInput", False),
            autoExtractFigure=config_dict.get("autoExtractFigure", False),
            autoExtractTikzFigure=config_dict.get("autoExtractTikzFigure", False),
            autoExtractTikzFigureReflect=config_dict.get("autoExtractTikzFigureReflect", False),
            includeTexCount=config_dict.get("includeTexCount", False),
            autoConfirmation=config_dict.get("autoConfirmation", False),
            printInputPrompt=config_dict.get("printInputPrompt", False),
        )
