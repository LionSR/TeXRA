from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""

    agent_type: str  # Core settings
    document_tag: str
    temperature: float | None = 0.0
    prefills: list[str] = field(default_factory=list)  # Generation settings
    output_ext: str = "txt"
    end_tag: str = "\\end{document}"
    required_files: dict[str, str] = field(default_factory=dict)  # File configurations
    required_files_internal: dict[str, str] = field(default_factory=dict)
    default_output_files: list[str] = field(default_factory=list)
    file_patterns_contain: list[dict[str, str]] = field(default_factory=list)

    def __post_init__(self):
        """Validate settings after initialization."""
        if self.agent_type not in ["CoT", "direct"]:
            raise ValueError(f"Invalid agent_type: {self.agent_type}. Must be 'CoT' or 'direct'")

        if self.temperature is not None and not 0.0 <= self.temperature <= 1.0:
            raise ValueError(f"Temperature must be between 0.0 and 1.0, got {self.temperature}")

        if not self.document_tag:
            raise ValueError("document_tag cannot be empty")

    @classmethod
    def from_dict(cls, settings_dict: dict[str, Any]) -> "AgentSettings":
        """Create an AgentSettings from a dictionary."""
        settings = cls(
            # Core settings
            agent_type=settings_dict.get("agent_type", "CoT"),
            document_tag=settings_dict.get("document_tag", "document"),
            temperature=settings_dict.get("temperature", 0.0),
            # Generation settings
            prefills=settings_dict.get("prefills", []),
            output_ext=settings_dict.get("output_ext", "txt"),
            end_tag=settings_dict.get("end_tag", "\\end{document}"),
            # File configurations
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
    def from_dict(cls, prompt_dict: dict[str, str]) -> "AgentPrompts":
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
