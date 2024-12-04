from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""

    # Document settings
    agent_type: Optional[str] = "think"
    document_tag: Optional[str] = None
    temperature: Optional[float] = 0.0
    prefills: Optional[List[str]] = field(default_factory=list)
    output_ext: str = "txt"
    end_tag: str = "\\end{document}"
    required_files: Optional[Dict[str, str]] = field(default_factory=dict)
    required_files_internal: Optional[Dict[str, str]] = field(default_factory=dict)
    default_output_files: Optional[List[str]] = field(default_factory=list)
    file_patterns_contain: Optional[List[Dict[str, str]]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, settings_dict: Dict[str, Any]) -> "AgentSettings":
        """Create an AgentSettings from a dictionary."""
        settings = cls(
            agent_type=settings_dict.get("agent_type", "think"),  # or "direct"
            document_tag=settings_dict.get("document_tag"),
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
        if self.end_tag in file_content:
            return True
        if self.document_tag:
            if f"</{self.document_tag}>" in file_content:
                return True
        if "\\end{document}" in file_content:
            return True
        return False


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
    use_prefill_from_input: bool
    auto_extract_figure: bool
    auto_extract_tikz_figure: bool
    auto_extract_tikz_figure_reflect: bool
    include_tex_count: bool

    # Processing configuration
    K: int = 200

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['input_file'])"""
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        """Dictionary-style get with default value"""
        return getattr(self, key, default)

    @classmethod
    def from_args(cls, args) -> "AgentConfig":
        """Create a AgentConfig from command line arguments."""
        config = cls(
            # Processing configuration
            reflect=args.reflect,
            model=args.model,
            agent=args.agent,
            # Input/Output configuration
            input_file=args.input_file,
            input_files=args.input_files,
            reference_file=args.reference_file,
            reference_files=args.reference_files,
            auxiliary_file=args.auxiliary_file,
            auxiliary_files=args.auxiliary_files,
            figure_file=args.figure_file,
            figure_files=args.figure_files,
            edited_file=args.edited_file,
            output_files=args.output_files,
            output_name_override=args.output_name_override,
            instruction=args.instruction,
            # Tool usage configuration
            use_prefill_from_input=args.use_prefill_from_input,
            include_tex_count=args.include_tex_count,
            auto_extract_figure=args.auto_extract_figure,
            auto_extract_tikz_figure=args.auto_extract_tikz_figure,
            auto_extract_tikz_figure_reflect=args.auto_extract_tikz_figure_reflect,
        )
        config.validate()
        return config

    def validate(self):
        """Validate the configuration."""
        # For multiple output agents
        if self.output_files:
            all_input_files = [self.input_file] + (self.input_files or [])
            if len(self.output_files) > len(all_input_files):
                raise ValueError("Number of output files must not be greater than the number of input files.")
