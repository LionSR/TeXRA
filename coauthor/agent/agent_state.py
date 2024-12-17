from dataclasses import dataclass, field

from ..logger import logger

from .response_usage import OpenAIResponseUsage, AnthropicResponseUsage


@dataclass
class AgentRoundState:
    """
    State for a single round (first round or reflection round).
    All metrics here are specific to this round only.
    """

    round_number: int
    continuation_count: int = 0
    response_time: float = 0
    output_file: str = ""
    model_usage: OpenAIResponseUsage | AnthropicResponseUsage | None = None

    @classmethod
    def initialize(cls, round_number: int) -> "AgentRoundState":
        """Initialize a new AgentRoundState object."""
        return cls(round_number=round_number)

    def update_token_counts(
        self,
        # Core content (required)
        response_usage: OpenAIResponseUsage | AnthropicResponseUsage,
    ) -> None:
        """Update token counts based on model response usage."""
        self.model_usage = response_usage

    def update_response_time(
        self,
        # Processing parameters (required)
        response_time: float,
    ) -> None:
        """Update response time for this round."""
        self.response_time += response_time

    def increment_continuation(self) -> None:
        """Increment continuation count for this round."""
        self.continuation_count += 1

    def to_dict(self) -> dict:
        """Convert round state to dictionary format."""
        return {
            "round_number": self.round_number,
            "continuation_count": self.continuation_count,
            "response_time": self.response_time,
            "output_file": self.output_file,
            "model_usage": self.model_usage,
        }


@dataclass
class ToolState:
    """
    State for tool-specific runtime data that doesn't need to be logged.
    This includes temporary data used during processing that is specific to each round.
    """

    tex_count_stats: str | None = None
    first_k_tex_document: str | None = None
    last_response: str = ""
    accumulated_output: str = ""
    figure_files: list[str] = field(default_factory=list)

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


@dataclass
class AgentGlobalState:
    """
    Global state tracking metrics across all rounds.
    Maintains cumulative statistics.
    """

    first_input_tokens: int = 0
    total_response_time: float = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    model_usage: OpenAIResponseUsage | AnthropicResponseUsage | None = None

    @classmethod
    def initialize(cls) -> "AgentGlobalState":
        """Initialize a new AgentGlobalState object."""
        return cls()

    def update_from_round(
        self,
        # State objects (required)
        round_state: AgentRoundState,
    ) -> None:
        """Update global metrics based on round state."""
        if round_state.model_usage:
            # Update first input tokens only for the first round
            if round_state.round_number == 0 and self.first_input_tokens == 0:
                self.first_input_tokens = round_state.model_usage["total_input_tokens"]
                # Add cache_read_input_tokens if it exists and is not None
                cache_read = round_state.model_usage.get("cache_read_input_tokens", 0) or 0
                self.first_input_tokens += cache_read
                logger.debug(f"First input tokens: {self.first_input_tokens}, cache_read: {cache_read}")

            # Update global totals (using total_input_tokens without cache adjustment)
            self.total_input_tokens += round_state.model_usage["total_input_tokens"]
            self.total_output_tokens += round_state.model_usage["total_output_tokens"]
            self.total_response_time += round_state.response_time

    def to_dict(self) -> dict:
        """Convert global state to dictionary format."""
        return {
            "first_input_tokens": self.first_input_tokens,
            "total_response_time": self.total_response_time,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
        }

    @classmethod
    def from_dict(cls, state_dict: dict | None) -> "AgentGlobalState":
        """Create AgentGlobalState object from dictionary."""
        if state_dict is None:
            return cls()

        return cls(
            first_input_tokens=state_dict.get("first_input_tokens", 0),
            total_response_time=state_dict.get("total_response_time", 0),
            total_input_tokens=state_dict.get("total_input_tokens", 0),
            total_output_tokens=state_dict.get("total_output_tokens", 0),
        )
