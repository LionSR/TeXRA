from dataclasses import dataclass, field


@dataclass
class ToolState:
    """State for tool-specific runtime data that doesn't need to be logged. [Per round]"""

    texCountStats: str | None = None  # Statistics about TeX document structure
    firstKCharsFromInput: str | None = None  # First K lines of TeX document
    lastResponse: str = ""  # Most recent model response
    accumulatedOutput: str = ""  # Combined output from all responses
    figureFiles: list[str] = field(default_factory=list)  # Paths to figure files

    @classmethod
    def initialize(cls) -> "ToolState":
        """Initialize a new ToolState object."""
        return cls()

    def update_lastResponse(self, response: str) -> None:
        """Update the last response."""
        self.lastResponse = response

    def update_accumulatedOutput(self, output: str) -> None:
        """Update the accumulated output."""
        self.accumulatedOutput = output

    def add_figureFiles(self, files: list[str]) -> None:
        """Add figure files to the list."""
        self.figureFiles.extend(files)
