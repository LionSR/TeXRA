from dataclasses import dataclass, field
from typing import Any

from .tool_config import ToolConfig


@dataclass
class AgentConfig:
    """Configuration for task execution and tool usage."""

    # Core configuration
    model: str
    reflect: bool
    agent: str
    instruction: str

    # Input/Output configuration
    inputFile: str
    inputFiles: list[str] | None
    referenceFile: str | None
    referenceFiles: list[str] | None
    auxiliaryFile: str | None
    auxiliaryFiles: list[str] | None
    figureFile: str | None
    figureFiles: list[str] | None
    outputFiles: list[str] | None
    outputNameOverride: str | None
    editedFile: str | None

    # Tool configuration
    toolConfig: ToolConfig = field(default_factory=ToolConfig)

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['inputFile'])"""
        # Handle nested toolConfig attributes
        if hasattr(self.toolConfig, key):
            return getattr(self.toolConfig, key)
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        """Dictionary-style get with default value"""
        try:
            return self[key]
        except AttributeError:
            return default

    @classmethod
    def from_kwargs(cls, **kwargs) -> "AgentConfig":
        """Create AgentConfig from keyword arguments"""

        # Default configuration
        config_defaults = {
            "model": "sonnet+",
            "reflect": False,
            "agent": "",
            "inputFile": "",
            "inputFiles": [],
            "referenceFile": None,
            "referenceFiles": [],
            "auxiliaryFile": None,
            "auxiliaryFiles": [],
            "figureFile": None,
            "figureFiles": [],
            "instruction": "",
            "outputFiles": None,
            "outputNameOverride": None,
            "editedFile": None,
        }

        # Extract tool config fields and create tool config
        tool_fields = {
            "usePrefillFromInput",
            "autoExtractFigure",
            "autoExtractTikzFigure",
            "autoExtractTikzFigureReflect",
            "includeTexCount",
            "autoConfirmation",
            "printInputPrompt",
        }
        # Keep original PascalCase for tool config fields while searching in lowercase
        tool_config = {k: kwargs.pop(k.lower(), False) for k in tool_fields}

        # Update defaults with provided kwargs (case-insensitive)
        config = {**config_defaults, **{k: kwargs.get(k.lower(), config_defaults[k]) for k in config_defaults}}

        # Create instance with config dict and tool config
        agent_config = cls(**config, toolConfig=ToolConfig(**tool_config))
        agent_config.validate()
        return agent_config

    def validate(self):
        """Validate the configuration."""
        # For multiple output agents
        if self.outputFiles:
            all_inputFiles = [self.inputFile] + (self.inputFiles or [])
            if len(self.outputFiles) > len(all_inputFiles):
                raise ValueError("Number of output files must not be greater than the number of input files.")
