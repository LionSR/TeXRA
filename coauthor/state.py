from dataclasses import dataclass
from typing import Optional


@dataclass
class State:
    """Class for managing state during processing."""

    continuation_count: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_response_time: float = 0
    last_response: str = ""
    first_input_tokens: int = 0
    total_cache_read_input_tokens: int = 0
    total_cache_creation_input_tokens: int = 0

    @classmethod
    def initialize(cls, accumulated_output: Optional[str] = None) -> "State":
        """Initialize a new State object with optional accumulated output."""
        return cls(last_response=accumulated_output or "")

    def update_token_counts(self, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_creation: int = 0) -> None:
        """Update token counts in state."""
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
            "continuation_count": self.continuation_count,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_response_time": self.total_response_time,
            "last_response": self.last_response,
            "first_input_tokens": self.first_input_tokens,
            "total_cache_read_input_tokens": self.total_cache_read_input_tokens,
            "total_cache_creation_input_tokens": self.total_cache_creation_input_tokens,
        }

    @classmethod
    def from_dict(cls, state_dict: Optional[dict]) -> "State":
        """Create State object from dictionary."""
        if state_dict is None:
            return cls()
        return cls(**state_dict)
