from typing import TypedDict


class ResponseUsageBase(TypedDict):
    """Base type for response usage statistics."""

    total_input_tokens: int
    total_output_tokens: int
    percentage_cached: float
    cost: float


class OpenAIResponseUsage(ResponseUsageBase):
    """Type for OpenAI response usage statistics."""

    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    reasoning_tokens: int


class AnthropicResponseUsage(ResponseUsageBase):
    """Type for Anthropic response usage statistics."""

    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
