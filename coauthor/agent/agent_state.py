from dataclasses import dataclass
from typing import Optional


@dataclass
class AgentState:
    """
    Class for managing state during processing.
    In principle this is model dependent, but here we use the same state for all models.

    In the future this should be per-round, (so use a different one for reflection rounds. Each node in the prompt chain should have its own state.)
    """

    # stats
    continuation_count: int = 0
    first_input_tokens: int = 0
    # tokens
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0  # openai
    reasoning_tokens: int = 0  # openai
    accepted_prediction_tokens: int = 0  # openai
    rejected_prediction_tokens: int = 0  # openai
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cached_tokens: int = 0  # openai
    total_cache_read_input_tokens: int = 0  # anthropic
    total_cache_creation_input_tokens: int = 0  # anthropic
    total_reasoning_tokens: int = 0  # openai
    total_accepted_prediction_tokens: int = 0  # openai
    total_rejected_prediction_tokens: int = 0  # openai
    # time
    response_time: float = 0
    total_response_time: float = 0
    # response
    last_response: str = ""

    @classmethod
    def initialize(cls, accumulated_output: Optional[str] = None) -> "AgentState":
        """Initialize a newAgentState object with optional accumulated output."""
        return cls(last_response=accumulated_output or "")

    def update_token_counts(self, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_creation: int = 0) -> None:
        """Update token counts in state."""
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_cache_read_input_tokens += cache_read
        self.total_cache_creation_input_tokens += cache_creation

        # Set first_input_tokens only on first update
        if self.continuation_count == 0:
            self.first_input_tokens = input_tokens + cache_read + cache_creation

    def update_response_time(self, response_time: float) -> None:
        """Update total response time."""
        self.total_response_time += response_time

    def increment_continuation(self) -> None:
        """Increment continuation count."""
        self.continuation_count += 1

    def to_dict(self) -> dict:
        """Convert state to dictionary format."""
        return {
            # stats
            "continuation_count": self.continuation_count,
            "first_input_tokens": self.first_input_tokens,
            # tokens
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "accepted_prediction_tokens": self.accepted_prediction_tokens,
            "rejected_prediction_tokens": self.rejected_prediction_tokens,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_reasoning_tokens": self.total_reasoning_tokens,
            "total_accepted_prediction_tokens": self.total_accepted_prediction_tokens,
            "total_rejected_prediction_tokens": self.total_rejected_prediction_tokens,
            "total_cache_read_input_tokens": self.total_cache_read_input_tokens,
            "total_cache_creation_input_tokens": self.total_cache_creation_input_tokens,
            # response
            "last_response": self.last_response,
            "total_response_time": self.total_response_time,
        }

    @classmethod
    def from_dict(cls, state_dict: Optional[dict]) -> "AgentState":
        """CreateAgentState object from dictionary."""
        if state_dict is None:
            return cls()
        return cls(**state_dict)
