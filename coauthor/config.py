from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any


@dataclass
class PromptTemplate:
    """Configuration for agent prompts."""

    system_prompt: str
    user_prefix_prompt: str
    user_request_prompt: str
    user_reflect_prompt: str

    @classmethod
    def from_dict(cls, prompt_dict: Dict[str, str]) -> "PromptTemplate":
        """Create a PromptTemplate from a dictionary of prompts."""
        return cls(
            system_prompt=prompt_dict.get("system_prompt", ""),
            user_prefix_prompt=prompt_dict.get("user_prefix", ""),
            user_request_prompt=prompt_dict.get("user_request", ""),
            user_reflect_prompt=prompt_dict.get("user_reflect", ""),
        )


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
    K: int
    
    @classmethod
    def from_args(cls, args) -> "TaskConfig":
        """Create a TaskConfig from command line arguments."""
        return cls(
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
            K=200,  # Default value
            
            # Tool usage configuration
            include_tex_count=args.include_tex_count,
            auto_extract_figure=args.auto_extract_figure,
            auto_extract_tikz_figure=args.auto_extract_tikz_figure,
            auto_extract_tikz_figure_reflect=args.auto_extract_tikz_figure_reflect,
        )


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""    
    # Document settings
    use_prefill_from_input: bool
    document_tag: Optional[str]
    prefills: List[str] = field(default_factory=list)
    output_ext: str = "txt"
    end_tag: str = "\\end{document}"
    
    @classmethod
    def from_dict(cls, args, settings_dict: Dict[str, Any]) -> "AgentSettings":
        """Create AgentSettings from command line arguments and settings dictionary."""
        return cls(            
            # Document settings
            use_prefill_from_input=args.use_prefill_from_input,
            prefills=settings_dict.get("prefills", []),
            document_tag=settings_dict.get("document_tag"),
            output_ext=settings_dict.get("output_ext", "txt"),
            end_tag=settings_dict.get("end_tag", "\\end{document}"),
        )
