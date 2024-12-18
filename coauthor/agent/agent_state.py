from dataclasses import dataclass

from ..logger import logger
from .response_usage import OpenAIResponseUsage, AnthropicResponseUsage


@dataclass
class AgentStateRound:
    """State for a single round (first round or reflection round)."""

    curr_round: int
    continuation_count: int = 0
    response_time: float = 0
    output_file: str = ""
    model_usage: OpenAIResponseUsage | AnthropicResponseUsage | None = None

    @classmethod
    def initialize(cls, curr_round: int) -> "AgentStateRound":
        """Initialize a new AgentStateRound object."""
        return cls(curr_round=curr_round)

    def update_token_counts(
        self,
        response_usage: OpenAIResponseUsage | AnthropicResponseUsage,  # Usage statistics from model response
    ) -> None:
        """Update token counts based on model response usage."""
        self.model_usage = response_usage

    def update_response_time(self, response_time: float) -> None:
        """Update response time for this round."""
        self.response_time += response_time

    def increment_continuation(self) -> None:
        """Increment continuation count for this round."""
        self.continuation_count += 1

    def to_dict(self) -> dict:
        """Convert round state to dictionary format."""
        return {
            "curr_round": self.curr_round,
            "continuation_count": self.continuation_count,
            "response_time": self.response_time,
            "output_file": self.output_file,
            "model_usage": self.model_usage,
        }


@dataclass
class AgentStateGlobal:
    """Global state tracking metrics across all rounds."""

    first_input_tokens: int = 0  # Token count of initial input
    total_response_time: float = 0  # Cumulative response time
    total_input_tokens: int = 0  # Total tokens consumed
    total_output_tokens: int = 0  # Total tokens generated
    total_rounds: int = 0  # Total number of rounds
    model_usage: OpenAIResponseUsage | AnthropicResponseUsage | None = None  # Overall usage stats

    @classmethod
    def initialize(cls) -> "AgentStateGlobal":
        """Initialize a new AgentStateGlobal object."""
        return cls()

    def update_from_curr_round(self, state_round: AgentStateRound) -> None:
        """Update global metrics based on round state."""
        if state_round.model_usage:
            if self.first_input_tokens == 0:
                self.first_input_tokens = state_round.model_usage.get("total_input_tokens", 0)
                cache_read = state_round.model_usage.get("cache_read_input_tokens", 0) or 0
                self.first_input_tokens += cache_read
                logger.debug(f"First input tokens: {self.first_input_tokens}, cache_read: {cache_read}")

            # Update global totals (using total_input_tokens without cache adjustment)
            self.total_input_tokens += state_round.model_usage.get("total_input_tokens", 0)
            self.total_output_tokens += state_round.model_usage.get("total_output_tokens", 0)

        self.total_response_time += state_round.response_time

    def to_dict(self) -> dict:
        """Convert global state to dictionary format."""
        return {
            "first_input_tokens": self.first_input_tokens,
            "total_response_time": self.total_response_time,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "model_usage": self.model_usage,
        }

    @classmethod
    def from_dict(cls, state_dict: dict | None) -> "AgentStateGlobal":
        """Create AgentStateGlobal object from dictionary."""
        if not state_dict:
            return cls()

        state = cls()
        state.first_input_tokens = state_dict.get("first_input_tokens", 0)
        state.total_response_time = state_dict.get("total_response_time", 0)
        state.total_input_tokens = state_dict.get("total_input_tokens", 0)
        state.total_output_tokens = state_dict.get("total_output_tokens", 0)
        state.model_usage = state_dict.get("model_usage")
        return state
