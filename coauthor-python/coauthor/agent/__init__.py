"""
Agent module for the coauthor package.
This module provides the core agent functionality for academic writing assistance.
"""

# Core dataclasses and configurations
from .agent_config import AgentConfig
from .agent_dataclass import AgentSetting, AgentPrompt
from .agent_state import AgentStateRound, AgentStateGlobal
from .tool_state import ToolState

# Base agent implementations
from .BaseReflectionAgent import BaseReflectionAgent

# Specialized agent implementations
from .CoTAgent import CoTAgent
from .DirectAgent import DirectAgent
from .MergeAgent import MergeAgent

# Utility and loading functions
from .agent_load import load_agent_settings_and_prompts
from .response_usage import ResponseUsageBase, OpenAIAPIResponseUsage, AnthropicAPIResponseUsage
from .output_handler import OutputHandler
from .logdb import (
    createLogEntry,
    updateLogStatistics,
    updateLogAndOutputFiles,
    getLogEntry,
)

# Model infrastructure
from .model_config import ModelConfig, ModelProvider, ModelCapabilities
from .model_handler import ModelHandler
from .model_handler_anthropic import AnthropicHandler
from .model_handler_openai import OpenAIHandler
from .model_handler_google import GoogleviaOpenAIHandler
from .model_handler_openrouter import OpenRouterHandler, AnthropicviaOpenrouterHandler
from .model_registry import MODEL_CONFIGS
from .model_factory import ModelFactory


__all__ = [
    # Core dataclasses and configurations
    "AgentConfig",
    "AgentSetting",
    "AgentPrompt",
    "AgentStateRound",
    "AgentStateGlobal",
    "ToolState",
    # Base agent class
    "BaseReflectionAgent",
    # Agent implementations
    "CoTAgent",
    "DirectAgent",
    "MergeAgent",
    # Utility and infrastructure
    "load_agent_settings_and_prompts",
    "ResponseUsageBase",
    "OpenAIAPIResponseUsage",
    "AnthropicAPIResponseUsage",
    "OutputHandler",
    "createLogEntry",
    "updateLogStatistics",
    "updateLogAndOutputFiles",
    "getLogEntry",
    # Model infrastructure
    "ModelConfig",
    "ModelProvider",
    "ModelCapabilities",
    "ModelHandler",
    "MODEL_CONFIGS",
    "ModelFactory",
    # Model implementations
    "AnthropicHandler",
    "OpenAIHandler",
    "GoogleviaOpenAIHandler",
    "OpenRouterHandler",
]
