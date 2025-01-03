from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentSettings:
    """Configuration for agent behavior and generation settings."""

    agentType: str  # Core settings
    documentTag: str
    temperature: float | None = 0.0
    prefills: list[str] = field(default_factory=list)  # Generation settings
    outputExt: str = "txt"
    endTag: str = "\\end{document}"
    requiredFiles: dict[str, str] = field(default_factory=dict)  # File configurations
    requiredFilesInternal: dict[str, str] = field(default_factory=dict)
    defaultOutputFiles: list[str] = field(default_factory=list)
    filePatternsContain: list[dict[str, str]] = field(default_factory=list)

    def __post_init__(self):
        """Validate settings after initialization."""
        if self.agentType not in ["CoT", "direct"]:
            raise ValueError(f"Invalid agentType: {self.agentType}. Must be 'CoT' or 'direct'")

        if self.temperature is not None and not 0.0 <= self.temperature <= 1.0:
            raise ValueError(f"Temperature must be between 0.0 and 1.0, got {self.temperature}")

        if not self.documentTag:
            raise ValueError("documentTag cannot be empty")

    @classmethod
    def from_dict(cls, settings_dict: dict[str, Any]) -> "AgentSettings":
        """Create an AgentSettings from a dictionary."""
        settings = cls(
            # Core settings
            agentType=settings_dict.get("agentType", "CoT"),
            documentTag=settings_dict.get("documentTag", "document"),
            temperature=settings_dict.get("temperature", 0.0),
            # Generation settings
            prefills=settings_dict.get("prefills", []),
            outputExt=settings_dict.get("outputExt", "txt"),
            endTag=settings_dict.get("endTag", "\\end{document}"),
            # File configurations
            requiredFiles=settings_dict.get("requiredFiles", {}),
            requiredFilesInternal=settings_dict.get("requiredFilesInternal", {}),
            defaultOutputFiles=settings_dict.get("defaultOutputFiles", []),
            filePatternsContain=settings_dict.get("filePatternsContain", []),
        )
        return settings

    def has_endTag(self, fileContent: str) -> bool:
        """Check if the file content contains the end tag or document tag."""
        return any([self.endTag in fileContent, self.documentTag and f"</{self.documentTag}>" in fileContent, "\\end{document}" in fileContent])


@dataclass
class AgentPrompts:
    """Configuration for agent prompts."""

    systemPrompt: str
    userPrefix: str
    userRequest: str
    userReflect: str

    @classmethod
    def from_dict(cls, prompt_dict: dict[str, str]) -> "AgentPrompts":
        """Create a AgentPrompts from a dictionary of prompts."""
        return cls(
            systemPrompt=prompt_dict.get("systemPrompt", ""),
            userPrefix=prompt_dict.get("userPrefix", ""),
            userRequest=prompt_dict.get("userRequest", ""),
            userReflect=prompt_dict.get("userReflect", ""),
        )

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['inputFile'])"""
        return getattr(self, key)
