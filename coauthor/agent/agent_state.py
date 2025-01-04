from dataclasses import dataclass, asdict

from ..logger import logger

from .response_usage import OpenAIAPIResponseUsage, AnthropicAPIResponseUsage


@dataclass
class AgentStateRound:
    """State for a single round (first round or reflection round)."""

    currRound: int
    continuationCount: int = 0
    responseTime: float = 0
    outputFile: str = ""
    APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | None = None

    @classmethod
    def initialize(cls, currRound: int) -> "AgentStateRound":
        """Initialize a new AgentStateRound object."""
        return cls(currRound=currRound)

    def update_token_counts(
        self,
        responseUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage,  # Usage statistics from model response
    ) -> None:
        """Update token counts based on model response usage."""
        self.APIUsage = responseUsage

    def update_responseTime(self, responseTime: float) -> None:
        """Update response time for this round."""
        self.responseTime += responseTime

    def increment_continuation(self) -> None:
        """Increment continuation count for this round."""
        self.continuationCount += 1

    def to_dict(self) -> dict:
        """Convert round state to dictionary format."""
        state_dict = asdict(self)
        # Handle APIUsage separately since it's a custom dataclass
        if self.APIUsage:
            state_dict["APIUsage"] = self.APIUsage.to_dict()
        return state_dict


@dataclass
class AgentStateGlobal:
    """Global state tracking metrics across all rounds."""

    firstInputTokens: int = 0  # Token count of initial input
    totalResponseTime: float = 0  # Cumulative response time
    totalInputTokens: int = 0  # Total tokens consumed
    totalOutputTokens: int = 0  # Total tokens generated
    totalRounds: int = 0  # Total number of rounds
    APIUsage: OpenAIAPIResponseUsage | AnthropicAPIResponseUsage | None = None  # Overall usage stats

    @classmethod
    def initialize(cls) -> "AgentStateGlobal":
        """Initialize a new AgentStateGlobal object."""
        return cls()

    def update_from_currRound(self, stateRound: AgentStateRound) -> None:
        """Update global metrics based on round state."""
        if stateRound.APIUsage:
            if self.firstInputTokens == 0:
                self.firstInputTokens = stateRound.APIUsage.totalInputTokens

            # For Anthropic API, handle cache tokens
            cache_read = getattr(stateRound.APIUsage, "cache_read_input_tokens", 0) or 0
            cache_creation = getattr(stateRound.APIUsage, "cache_creation_input_tokens", 0) or 0
            self.firstInputTokens += cache_read + cache_creation
            logger.debug(f"First input tokens: {self.firstInputTokens}, cache_read: {cache_read}, cache_creation: {cache_creation}")

            # Update global totals (using totalInputTokens without cache adjustment)
            self.totalInputTokens += stateRound.APIUsage.totalInputTokens
            self.totalOutputTokens += stateRound.APIUsage.totalOutputTokens

        self.totalResponseTime += stateRound.responseTime

    def to_dict(self) -> dict:
        """Convert global state to dictionary format."""
        state_dict = asdict(self)
        # Handle APIUsage separately since it's a custom dataclass
        if self.APIUsage:
            state_dict["APIUsage"] = self.APIUsage.to_dict()
        return state_dict

    @classmethod
    def from_dict(cls, state_dict: dict | None) -> "AgentStateGlobal":
        """Create AgentStateGlobal object from dictionary."""
        if not state_dict:
            return cls()

        state = cls()
        state.firstInputTokens = state_dict.get("firstInputTokens", 0)
        state.totalResponseTime = state_dict.get("totalResponseTime", 0)
        state.totalInputTokens = state_dict.get("totalInputTokens", 0)
        state.totalOutputTokens = state_dict.get("totalOutputTokens", 0)
        state.APIUsage = state_dict.get("APIUsage")
        return state
