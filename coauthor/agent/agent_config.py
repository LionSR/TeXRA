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

    # Processing configuration
    K: int = 200

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

        # Create dict with default values for all fields
        config_defaults = {
            # Core configuration
            "model": "sonnet+",
            "reflect": False,
            "agent": "",
            # Input/Output configuration
            "inputFile": "",
            "inputFiles": [],
            "referenceFile": None,
            "referenceFiles": [],
            "auxiliaryFile": None,
            "auxiliaryFiles": [],
            "figureFile": None,
            "figureFiles": [],
            # Instruction
            "instruction": "",
            # Output
            "outputFiles": None,
            "outputNameOverride": None,
            "editedFile": None,
        }

        # Extract tool configuration fields
        toolConfig_fields = {
            k: kwargs.pop(k.lower(), False)
            for k in [
                "usePrefillFromInput",
                "autoExtractFigure",
                "autoExtractTikzFigure",
                "autoExtractTikzFigureReflect",
                "includeTexCount",
                "autoConfirmation",
                "printInputPrompt",
            ]
        }

        # Update defaults with provided kwargs, handling case-insensitive keys
        config = {key: kwargs.get(key.lower(), default) for key, default in config_defaults.items()}

        # Create instance with unpacked config dict and tool config
        agentConfig = cls(**config, toolConfig=ToolConfig.from_dict(toolConfig_fields))
        agentConfig.validate()
        return agentConfig

    def validate(self):
        """Validate the configuration."""
        # For multiple output agents
        if self.outputFiles:
            all_inputFiles = [self.inputFile] + (self.inputFiles or [])
            if len(self.outputFiles) > len(all_inputFiles):
                raise ValueError("Number of output files must not be greater than the number of input files.")
