"""
Agent module for the coauthor package.
This module provides the core agent functionality for academic writing assistance.
"""

# Core dataclasses and configurations
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_state import AgentRoundState, AgentGlobalState
from .tool_handler import ToolState

# Base agent implementations
from .agent_base import BaseReflectChainAgent

# Specialized agent implementations
from .agent_reflect import ThinkAndWrite, DirectWrite
from .agent_merge import AgentMerge

# Utility and loading functions
from .agent_load import load_agent_settings_and_prompts
from .response_usage import ResponseUsageBase, OpenAIResponseUsage, AnthropicResponseUsage
from .output_handler import OutputHandler
from .logdb import (
    create_log_entry,
    update_log_statistics,
    update_log_output_files,
    get_log_entry,
)

# Model infrastructure
from .model_config import ModelConfig, ModelProvider, ModelCapabilities
from .model_handler import ModelHandler
from .model_handler_anthropic import AnthropicHandler
from .model_handler_openai import OpenAIHandler, GoogleviaOpenAIHandler
from .model_registry import MODEL_CONFIGS
from .model_factory import ModelFactory


__all__ = [
    # Core dataclasses and configurations
    "AgentConfig",
    "AgentSettings",
    "AgentPrompts",
    "AgentRoundState",
    "AgentGlobalState",
    "ToolState",
    # Base agent class
    "BaseReflectChainAgent",
    # Agent implementations
    "ThinkAndWrite",
    "DirectWrite",
    "AgentMerge",
    # Utility and infrastructure
    "load_agent_settings_and_prompts",
    "ResponseUsageBase",
    "OpenAIResponseUsage",
    "AnthropicResponseUsage",
    "OutputHandler",
    "create_log_entry",
    "update_log_statistics",
    "update_log_output_files",
    "get_log_entry",
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
]
