from dataclasses import dataclass
from typing import Optional, Union

from .response_usage import OpenAIResponseUsage, AnthropicResponseUsage

ModelUsageType = Union[OpenAIResponseUsage, AnthropicResponseUsage]


@dataclass
class AgentRoundState:
    """
    State for a single round (first round or reflection round).
    All metrics here are specific to this round only.
    """

    round_number: int
    continuation_count: int = 0
    response_time: float = 0
    last_response: str = ""
    output_file: str = ""
    model_usage: ModelUsageType | None = None

    @classmethod
    def initialize(cls, round_number: int, accumulated_output: str | None = None) -> "AgentRoundState":
        """Initialize a new AgentRoundState object."""
        return cls(round_number=round_number, last_response=accumulated_output or "")

    def update_token_counts(self, response_usage: ModelUsageType) -> None:
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
            "round_number": self.round_number,
            "continuation_count": self.continuation_count,
            "response_time": self.response_time,
            "output_file": self.output_file,
            "model_usage": self.model_usage,
        }


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
    model_usage: ModelUsageType | None = None

    @classmethod
    def initialize(cls) -> "AgentGlobalState":
        """Initialize a new AgentGlobalState object."""
        return cls()

    def update_from_round(self, round_state: AgentRoundState) -> None:
        """Update global metrics based on round state."""
        if round_state.model_usage:
            # Update first input tokens only for the first round
            if round_state.round_number == 0 and self.first_input_tokens == 0:
                self.first_input_tokens = round_state.model_usage["total_input_tokens"]

            # Update global totals
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
