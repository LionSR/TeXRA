from dataclasses import dataclass, asdict
from typing import Any


@dataclass
class ResponseUsageBase:
    """Base class for response usage statistics."""

    totalInputTokens: int
    totalOutputTokens: int
    percentageCached: float
    cost: float
    responseTime: float

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
class OpenAIAPIResponseUsage(ResponseUsageBase):
    """Class for OpenAI response usage statistics."""

    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    accepted_prediction_tokens: int | None
    rejected_prediction_tokens: int | None

    @classmethod
    def from_response(cls, responseUsage: Any, cost: float, responseTime: float) -> "OpenAIAPIResponseUsage":
        # Extract tokens from response usag
        prompt_tokens_details = getattr(responseUsage, "prompt_tokens_details", None)
        cached_tokens = getattr(prompt_tokens_details, "cached_tokens", 0) if prompt_tokens_details else 0

        # Extract completion details
        completion_tokens_details = getattr(responseUsage, "completion_tokens_details", None)
        reasoning_tokens = getattr(completion_tokens_details, "reasoning_tokens", 0) if completion_tokens_details else 0
        accepted_prediction_tokens = getattr(completion_tokens_details, "accepted_prediction_tokens", None) if completion_tokens_details else None
        rejected_prediction_tokens = getattr(completion_tokens_details, "rejected_prediction_tokens", None) if completion_tokens_details else None

        # Calculate percentage cached
        percentageCached = (cached_tokens / responseUsage.prompt_tokens * 100) if responseUsage.prompt_tokens > 0 else 0

        return cls(
            # base fields
            totalInputTokens=responseUsage.prompt_tokens,
            totalOutputTokens=responseUsage.completion_tokens,
            percentageCached=percentageCached,
            cost=cost,
            responseTime=responseTime,
            # relevant fields from openai api response in snake_case
            prompt_tokens=responseUsage.prompt_tokens,
            completion_tokens=responseUsage.completion_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            accepted_prediction_tokens=accepted_prediction_tokens,
            rejected_prediction_tokens=rejected_prediction_tokens,
        )


@dataclass
class AnthropicAPIResponseUsage(ResponseUsageBase):
    """Class for Anthropic response usage statistics."""

    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int | None
    cache_creation_input_tokens: int | None

    @classmethod
    def from_response(cls, responseUsage: Any, cost: float, responseTime: float) -> "AnthropicAPIResponseUsage":
        # Extract cache-related tokens
        cache_read_input_tokens = getattr(responseUsage, "cache_read_input_tokens", None)
        cache_creation_input_tokens = getattr(responseUsage, "cache_creation_input_tokens", None)

        # Calculate percentage cached
        total_cache_tokens = (cache_read_input_tokens or 0) + (cache_creation_input_tokens or 0)
        percentageCached = (total_cache_tokens / responseUsage.input_tokens * 100) if responseUsage.input_tokens > 0 else 0

        return cls(
            # base fields
            totalInputTokens=responseUsage.input_tokens,
            totalOutputTokens=responseUsage.output_tokens,
            percentageCached=percentageCached,
            cost=cost,
            responseTime=responseTime,
            # relevant fields from anthropic api response in snake_case
            input_tokens=responseUsage.input_tokens,
            output_tokens=responseUsage.output_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
        )
