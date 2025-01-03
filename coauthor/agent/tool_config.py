"""Tool configuration data structures."""

from dataclasses import dataclass


@dataclass
class ToolConfig:
    """Configuration for tool usage and automation features."""

    use_prefill_from_input: bool = False
    auto_extract_figure: bool = False
    auto_extract_tikz_figure: bool = False
    auto_extract_tikz_figure_reflect: bool = False
    include_tex_count: bool = False
    auto_confirmation: bool = False
    print_input_prompt: bool = False

    @classmethod
    def from_dict(cls, config_dict: dict[str, bool]) -> "ToolConfig":
        """Create a ToolConfig from a dictionary."""
        return cls(
            use_prefill_from_input=config_dict.get("use_prefill_from_input", False),
            auto_extract_figure=config_dict.get("auto_extract_figure", False),
            auto_extract_tikz_figure=config_dict.get("auto_extract_tikz_figure", False),
            auto_extract_tikz_figure_reflect=config_dict.get("auto_extract_tikz_figure_reflect", False),
            include_tex_count=config_dict.get("include_tex_count", False),
            auto_confirmation=config_dict.get("auto_confirmation", False),
            print_input_prompt=config_dict.get("print_input_prompt", False),
        )
