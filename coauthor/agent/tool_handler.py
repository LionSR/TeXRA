from dataclasses import dataclass, field


@dataclass
class ToolState:
    """State for tool-specific runtime data that doesn't need to be logged. [Per round]"""

    tex_count_stats: str | None = None  # Statistics about TeX document structure
    first_k_tex_document: str | None = None  # First K lines of TeX document
    last_response: str = ""  # Most recent model response
    accumulated_output: str = ""  # Combined output from all responses
    figure_files: list[str] = field(default_factory=list)  # Paths to figure files

    @classmethod
    def initialize(cls) -> "ToolState":
        """Initialize a new ToolState object."""
        return cls()

    def update_last_response(self, response: str) -> None:
        """Update the last response."""
        self.last_response = response

    def update_accumulated_output(self, output: str) -> None:
        """Update the accumulated output."""
        self.accumulated_output = output

    def add_figure_files(self, files: list[str]) -> None:
        """Add figure files to the list."""
        self.figure_files.extend(files)
