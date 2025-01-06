from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentSetting:
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
    def from_dict(cls, settingDict: dict[str, Any]) -> "AgentSetting":
        """Create an AgentSetting from a dictionary."""
        settings = cls(
            # Core settings
            agentType=settingDict.get("agentType", "CoT"),
            documentTag=settingDict.get("documentTag", "document"),
            temperature=settingDict.get("temperature", 0.0),
            # Generation settings
            prefills=settingDict.get("prefills", []),
            outputExt=settingDict.get("outputExt", "txt"),
            endTag=settingDict.get("endTag", "\\end{document}"),
            # File configurations
            requiredFiles=settingDict.get("requiredFiles", {}),
            requiredFilesInternal=settingDict.get("requiredFilesInternal", {}),
            defaultOutputFiles=settingDict.get("defaultOutputFiles", []),
            filePatternsContain=settingDict.get("filePatternsContain", []),
        )
        return settings

    def has_endTag(self, fileContent: str) -> bool:
        """Check if the file content contains the end tag or document tag."""
        return any([self.endTag in fileContent, self.documentTag and f"</{self.documentTag}>" in fileContent, "\\end{document}" in fileContent])


@dataclass
class AgentPrompt:
    """Configuration for agent prompts."""

    systemPrompt: str
    userPrefix: str
    userRequest: str
    userReflect: str

    @classmethod
    def from_dict(cls, promptDict: dict[str, str]) -> "AgentPrompt":
        """Create a AgentPrompt from a dictionary of prompts."""
        return cls(
            systemPrompt=promptDict.get("systemPrompt", ""),
            userPrefix=promptDict.get("userPrefix", ""),
            userRequest=promptDict.get("userRequest", ""),
            userReflect=promptDict.get("userReflect", ""),
        )

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['inputFile'])"""
        return getattr(self, key)
