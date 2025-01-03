from dataclasses import dataclass, asdict
from typing import Any


@dataclass
class ResponseUsageBase:
    """Base class for response usage statistics."""

    total_input_tokens: int
    total_output_tokens: int
    percentage_cached: float
    cost: float
    response_time: float

    def __getitem__(self, key: str) -> Any:
        """Enable dictionary-style access (config['cost'])"""
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        """Dictionary-style get with default value"""
        try:
            return self[key]
        except AttributeError:
            return default

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


@dataclass
class OpenAIResponseUsage(ResponseUsageBase):
    """Class for OpenAI response usage statistics."""

    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    accepted_prediction_tokens: int | None
    rejected_prediction_tokens: int | None

    @classmethod
    def from_response(cls, response_usage: Any, cost: float, response_time: float) -> "OpenAIResponseUsage":
        # Extract tokens from response usage
        cached_tokens = getattr(response_usage.prompt_tokens_details, "cached_tokens", 0) if hasattr(response_usage, "prompt_tokens_details") else 0

        # Extract completion details
        completion_details = getattr(response_usage, "completion_tokens_details", None)
        reasoning_tokens = getattr(completion_details, "reasoning_tokens", 0) if completion_details else 0
        accepted_prediction_tokens = getattr(completion_details, "accepted_prediction_tokens", None) if completion_details else None
        rejected_prediction_tokens = getattr(completion_details, "rejected_prediction_tokens", None) if completion_details else None

        # Calculate percentage cached
        percentage_cached = (cached_tokens / response_usage.prompt_tokens * 100) if response_usage.prompt_tokens > 0 else 0

        return cls(
            total_input_tokens=response_usage.prompt_tokens,
            total_output_tokens=response_usage.completion_tokens,
            prompt_tokens=response_usage.prompt_tokens,
            completion_tokens=response_usage.completion_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            accepted_prediction_tokens=accepted_prediction_tokens,
            rejected_prediction_tokens=rejected_prediction_tokens,
            percentage_cached=percentage_cached,
            cost=cost,
            response_time=response_time,
        )


@dataclass
class AnthropicResponseUsage(ResponseUsageBase):
    """Class for Anthropic response usage statistics."""

    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int | None
    cache_creation_input_tokens: int | None

    @classmethod
    def from_response(cls, response_usage: Any, cost: float, response_time: float) -> "AnthropicResponseUsage":
        # Extract cache-related tokens
        cache_read_input_tokens = getattr(response_usage, "cache_read_input_tokens", None)
        cache_creation_input_tokens = getattr(response_usage, "cache_creation_input_tokens", None)

        # Calculate percentage cached
        total_cache_tokens = (cache_read_input_tokens or 0) + (cache_creation_input_tokens or 0)
        percentage_cached = (total_cache_tokens / response_usage.input_tokens * 100) if response_usage.input_tokens > 0 else 0

        return cls(
            total_input_tokens=response_usage.input_tokens,
            total_output_tokens=response_usage.output_tokens,
            input_tokens=response_usage.input_tokens,
            output_tokens=response_usage.output_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            percentage_cached=percentage_cached,
            cost=cost,
            response_time=response_time,
        )
