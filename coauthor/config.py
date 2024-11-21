from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""

    # Document settings
    document_tag: Optional[str]
    prefills: List[str] = field(default_factory=list)
    output_ext: str = "txt"
    end_tag: str = "\\end{document}"
    required_files: Dict[str, str] = field(default_factory=dict)
    required_files_internal: Dict[str, str] = field(default_factory=dict)
    default_output_files: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, settings_dict: Dict[str, Any]) -> "AgentSettings":
        """Create an AgentSettings from a dictionary."""
        settings = cls(
            document_tag=settings_dict.get("document_tag"),
            prefills=settings_dict.get("prefills", []),
            output_ext=settings_dict.get("output_ext", "txt"),
            end_tag=settings_dict.get("end_tag", "\\end{document}"),
            required_files=settings_dict.get("required_files", {}),
            required_files_internal=settings_dict.get("required_files_internal", {}),
            default_output_files=settings_dict.get("default_output_files", []),
        )
        return settings


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
class TaskConfig:
    """Configuration for task execution and tool usage."""

    model: str
    temperature: float
    reflect: bool
    agent: str

    # Input/Output configuration
    input_file: str
    input_files: Optional[List[str]]
    sample_files: Optional[List[str]]
    auxiliary_files: Optional[List[str]]
    figure_inputs: Optional[List[str]]
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
    def from_args(cls, args) -> "TaskConfig":
        """Create a TaskConfig from command line arguments."""
        config = cls(
            # Input/Output configuration
            input_file=args.input_file,
            input_files=args.input_files,
            sample_files=args.sample_files,
            auxiliary_files=args.auxiliary_files,
            edited_file=args.edited_file,
            figure_inputs=args.figure_inputs,
            output_files=args.output_files,
            output_name_override=args.output_name_override,
            instruction=args.instruction,
            # Processing configuration
            reflect=args.reflect,
            use_prefill_from_input=args.use_prefill_from_input,
            temperature=args.temperature,
            model=args.model,
            agent=args.agent,
            # Tool usage configuration
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
