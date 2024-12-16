from typing import TypedDict, Optional, Any


class ResponseUsageBase(TypedDict):
    """Base type for response usage statistics.
    Contains common fields across all model types.
    """

    total_input_tokens: int
    total_output_tokens: int
    percentage_cached: float
    cost: float
    response_time: float


class OpenAIResponseUsage(ResponseUsageBase):
    """Type for OpenAI response usage statistics.
    Includes OpenAI-specific fields for token tracking.
    """

    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    accepted_prediction_tokens: int | None
    rejected_prediction_tokens: int | None

    @classmethod
    def from_response(cls, response_usage: Any, cost: float, response_time: float) -> "OpenAIResponseUsage":
        """Create OpenAIResponseUsage from raw response usage object.

        Args:
            response_usage: Raw OpenAI response usage object
            cost: Computed cost for this response
            response_time: Time taken for this response

        Returns:
            OpenAIResponseUsage object with computed statistics
        """
        cached_tokens = 0
        reasoning_tokens = 0
        accepted_prediction_tokens = None
        rejected_prediction_tokens = None

        # Extract cached tokens if available
        if hasattr(response_usage, "prompt_tokens_details"):
            if hasattr(response_usage.prompt_tokens_details, "cached_tokens"):
                cached_tokens = response_usage.prompt_tokens_details.cached_tokens

        # Extract reasoning and prediction tokens if available
        if hasattr(response_usage, "completion_tokens_details"):
            if hasattr(response_usage.completion_tokens_details, "reasoning_tokens"):
                reasoning_tokens = response_usage.completion_tokens_details.reasoning_tokens
            if hasattr(response_usage.completion_tokens_details, "accepted_prediction_tokens"):
                accepted_prediction_tokens = response_usage.completion_tokens_details.accepted_prediction_tokens
            if hasattr(response_usage.completion_tokens_details, "rejected_prediction_tokens"):
                rejected_prediction_tokens = response_usage.completion_tokens_details.rejected_prediction_tokens

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


class AnthropicResponseUsage(ResponseUsageBase):
    """Type for Anthropic response usage statistics.
    Includes Anthropic-specific fields for token tracking.
    """

    input_tokens: int
    output_tokens: int
    cache_read_tokens: int | None
    cache_creation_tokens: int | None

    @classmethod
    def from_response(cls, response_usage: Any, cost: float, response_time: float) -> "AnthropicResponseUsage":
        """Create AnthropicResponseUsage from raw response usage object.

        Args:
            response_usage: Raw Anthropic response usage object
            cost: Computed cost for this response
            response_time: Time taken for this response

        Returns:
            AnthropicResponseUsage object with computed statistics
        """
        cache_read_tokens = None
        cache_creation_tokens = None
        percentage_cached = 0.0

        # Extract cache tokens if available
        if hasattr(response_usage, "cache_read_input_tokens"):
            cache_read_tokens = response_usage.cache_read_input_tokens
        if hasattr(response_usage, "cache_creation_input_tokens"):
            cache_creation_tokens = response_usage.cache_creation_input_tokens

        # Calculate percentage cached if cache tokens are available
        if cache_read_tokens is not None and cache_creation_tokens is not None:
            total_cache_tokens = cache_read_tokens + cache_creation_tokens
            percentage_cached = (total_cache_tokens / response_usage.input_tokens * 100) if response_usage.input_tokens > 0 else 0

        return cls(
            total_input_tokens=response_usage.input_tokens,
            total_output_tokens=response_usage.output_tokens,
            input_tokens=response_usage.input_tokens,
            output_tokens=response_usage.output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
            percentage_cached=percentage_cached,
            cost=cost,
            response_time=response_time,
        )
