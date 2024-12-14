from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""

    agent_type: str
    document_tag: str
    temperature: Optional[float] = 0.0
    prefills: List[str] = field(default_factory=list)
    output_ext: str = "txt"
    end_tag: str = "\\end{document}"
    required_files: Dict[str, str] = field(default_factory=dict)
    required_files_internal: Dict[str, str] = field(default_factory=dict)
    default_output_files: List[str] = field(default_factory=list)
    file_patterns_contain: List[Dict[str, str]] = field(default_factory=list)

    def __post_init__(self):
        """Validate settings after initialization."""
        if self.agent_type not in ["think", "direct"]:
            raise ValueError(f"Invalid agent_type: {self.agent_type}. Must be 'think' or 'direct'")

        if self.temperature is not None and not 0.0 <= self.temperature <= 1.0:
            raise ValueError(f"Temperature must be between 0.0 and 1.0, got {self.temperature}")

        if not self.document_tag:
            raise ValueError("document_tag cannot be empty")

    @classmethod
    def from_dict(cls, settings_dict: Dict[str, Any]) -> "AgentSettings":
        """Create an AgentSettings from a dictionary."""
        settings = cls(
            agent_type=settings_dict.get("agent_type", "think"),
            document_tag=settings_dict.get("document_tag", "document"),
            temperature=settings_dict.get("temperature", 0.0),
            prefills=settings_dict.get("prefills", []),
            output_ext=settings_dict.get("output_ext", "txt"),
            end_tag=settings_dict.get("end_tag", "\\end{document}"),
            required_files=settings_dict.get("required_files", {}),
            required_files_internal=settings_dict.get("required_files_internal", {}),
            default_output_files=settings_dict.get("default_output_files", []),
            file_patterns_contain=settings_dict.get("file_patterns_contain", []),
        )
        return settings

    def has_end_tag(self, file_content: str) -> bool:
        """Check if the file content contains the end tag or document tag."""
        return any([self.end_tag in file_content, self.document_tag and f"</{self.document_tag}>" in file_content, "\\end{document}" in file_content])


@dataclass
class AgentPrompts:
    """Configuration for agent prompts."""

    system_prompt: str
    user_prefix: str
    user_request: str
    user_reflect: str

    @classmethod
    def from_dict(cls, prompt_dict: Dict[str, str]) -> "AgentPrompts":
        """Create a AgentPrompts from a dictionary of prompts."""
        return cls(
            system_prompt=prompt_dict.get("system_prompt", ""),
            user_prefix=prompt_dict.get("user_prefix", ""),
            user_request=prompt_dict.get("user_request", ""),
            user_reflect=prompt_dict.get("user_reflect", ""),
        )

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['input_file'])"""
        return getattr(self, key)


@dataclass
class AgentConfig:
    """Configuration for task execution and tool usage."""

    model: str
    reflect: bool
    agent: str

    # Input/Output configuration
    input_file: str
    input_files: Optional[List[str]]
    reference_file: Optional[str]
    reference_files: Optional[List[str]]
    auxiliary_file: Optional[str]
    auxiliary_files: Optional[List[str]]
    figure_file: Optional[str]
    figure_files: Optional[List[str]]
    output_files: Optional[List[str]]
    output_name_override: Optional[str]
    edited_file: Optional[str]
    instruction: Optional[str]

    # Tool usage configuration
    use_prefill_from_input: bool = False
    auto_extract_figure: bool = False
    auto_extract_tikz_figure: bool = False
    auto_extract_tikz_figure_reflect: bool = False
    include_tex_count: bool = False

    # Processing configuration
    K: int = 200

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['input_file'])"""
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        """Dictionary-style get with default value"""
        return getattr(self, key, default)

    @classmethod
    def from_kwargs(cls, **kwargs) -> "AgentConfig":
        """Create AgentConfig from keyword arguments"""
        # Handle defaults and conversions
        agent_config = cls(
            # Processing configuration
            model=kwargs.get("model", "sonnet+"),
            reflect=kwargs.get("reflect", False),
            agent=kwargs.get("agent", ""),
            instruction=kwargs.get("instruction"),
            # Input/Output configuration
            input_file=kwargs.get("input_file", ""),
            input_files=kwargs.get("input_files", []),
            reference_file=kwargs.get("reference_file"),
            reference_files=kwargs.get("reference_files", []),
            auxiliary_file=kwargs.get("auxiliary_file"),
            auxiliary_files=kwargs.get("auxiliary_files", []),
            figure_file=kwargs.get("figure_file"),
            figure_files=kwargs.get("figure_files", []),
            output_files=kwargs.get("output_files"),
            output_name_override=kwargs.get("output_name_override"),
            edited_file=kwargs.get("edited_file"),
            # Tool usage configuration
            use_prefill_from_input=kwargs.get("use_prefill_from_input", False),
            include_tex_count=kwargs.get("include_tex_count", False),
            auto_extract_figure=kwargs.get("auto_extract_figure", False),
            auto_extract_tikz_figure=kwargs.get("auto_extract_tikz_figure", False),
            auto_extract_tikz_figure_reflect=kwargs.get("auto_extract_tikz_figure_reflect", False),
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
