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
    input_file: str
    input_files: list[str] | None
    reference_file: str | None
    reference_files: list[str] | None
    auxiliary_file: str | None
    auxiliary_files: list[str] | None
    figure_file: str | None
    figure_files: list[str] | None
    output_files: list[str] | None
    output_name_override: str | None
    edited_file: str | None

    # Tool configuration
    tool_config: ToolConfig = field(default_factory=ToolConfig)

    # Processing configuration
    K: int = 200

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['input_file'])"""
        # Handle nested tool_config attributes
        if hasattr(self.tool_config, key):
            return getattr(self.tool_config, key)
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
        # Extract tool configuration fields
        tool_config_fields = {
            k: kwargs.pop(k, False)
            for k in [
                "use_prefill_from_input",
                "auto_extract_figure",
                "auto_extract_tikz_figure",
                "auto_extract_tikz_figure_reflect",
                "include_tex_count",
                "auto_confirmation",
                "print_input_prompt",
            ]
        }

        agent_config = cls(
            # Core configuration
            model=kwargs.get("model", "sonnet+"),
            # parameters
            reflect=kwargs.get("reflect", False),
            agent=kwargs.get("agent", ""),
            # Input/Output configuration
            input_file=kwargs.get("input_file", ""),
            input_files=kwargs.get("input_files", []),
            reference_file=kwargs.get("reference_file"),
            reference_files=kwargs.get("reference_files", []),
            auxiliary_file=kwargs.get("auxiliary_file"),
            auxiliary_files=kwargs.get("auxiliary_files", []),
            figure_file=kwargs.get("figure_file"),
            figure_files=kwargs.get("figure_files", []),
            # instruction
            instruction=kwargs.get("instruction", ""),
            # output
            output_files=kwargs.get("output_files"),
            output_name_override=kwargs.get("output_name_override"),
            edited_file=kwargs.get("edited_file"),
            # Tool configuration
            tool_config=ToolConfig.from_dict(tool_config_fields),
        )
        agent_config.validate()
        return agent_config

    def validate(self):
        """Validate the configuration."""
        # For multiple output agents
        if self.output_files:
            all_input_files = [self.input_file] + (self.input_files or [])
            if len(self.output_files) > len(all_input_files):
                raise ValueError("Number of output files must not be greater than the number of input files.")
