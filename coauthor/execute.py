"""Execute agent tasks."""

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from .logger import logger

from .agent.agent_dataclass import AgentSettings, AgentPrompts
from .agent.agent_config import AgentConfig
from .agent.agent_load import load_agent_settings_and_prompts

from .agent.model_registry import MODEL_CONFIGS
from .agent.model_factory import ModelFactory

from .agent.agent_base import BaseReflectionAgent
from .agent.agent_class_cot import CoTAgent
from .agent.agent_class_direct import DirectAgent
from .agent.agent_class_merge import AgentMerge

load_dotenv()


def get_agent_dir_from_env() -> str:
    """Get the agent directory path from environment or default location."""
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    agents_dir = os.getenv("AGENTS_DIR", f"{script_dir}/agents")
    return agents_dir


def create_agent_config(**kwargs: Any) -> AgentConfig:
    """Create and return AgentConfig object from CLI kwargs, converting string lists as needed."""
    required_fields = ["model", "agent"]
    missing_fields = [field for field in required_fields if field not in kwargs]
    if missing_fields:
        raise ValueError(f"Missing required fields: {', '.join(missing_fields)}")

    # Convert comma-separated strings to lists
    list_fields = ["input_files", "reference_files", "auxiliary_files", "figure_files", "output_files"]
    for field in list_fields:
        if isinstance(kwargs.get(field), str):
            kwargs[field] = [f.strip() for f in kwargs[field].split(",")]
        elif kwargs.get(field) is None:
            kwargs[field] = []

    return AgentConfig.from_kwargs(**kwargs)


def get_agent_class(agent_path: str, agent: str) -> type[BaseReflectionAgent]:
    """Return DirectAgent or CoTAgent agent class based on yaml settings."""
    settings_dict, _ = load_agent_settings_and_prompts(agent_path, agent)
    return DirectAgent if settings_dict.get("agentType") == "direct" else CoTAgent


def get_agent_name(base_agent: str, output_files: list[str] | None = None) -> str:
    """Return agent name with '_multiple' suffix if output files exist."""
    return f"{base_agent}_multiple" if output_files else base_agent


def get_agent_path(agent_name: str) -> str:
    """Find and return the path to agent's yaml configuration file."""
    agents_dir = Path(get_agent_dir_from_env())
    if yaml_path := next((p for p in agents_dir.rglob(f"{agent_name}.yaml")), None):
        return str(yaml_path.parent)

    error_msg = f"Could not find yaml file for agent: {agent_name}"
    logger.error(f"{error_msg} from {agents_dir}")
    raise ValueError(error_msg)


def run_agent(agent: str, **kwargs: Any) -> None:
    """Initialize and run the specified agent with given configuration."""
    agent_name = get_agent_name(agent, kwargs.get("output_files"))
    agent_path = get_agent_path(agent_name)
    agent_config = create_agent_config(agent=agent_name, **kwargs)

    model_name = agent_config.model
    if model_name not in MODEL_CONFIGS:
        raise ValueError(f"Model {model_name} not found in MODEL_CONFIGS")

    model_config = MODEL_CONFIGS[model_name]
    # Only override use_openrouter if it's not already True in the model config
    if not model_config.use_openrouter:
        model_config.use_openrouter = kwargs.get("use_openrouter", False)

    model_handler = ModelFactory.create_handler(model_config)

    agent_settings_dict, agent_prompts_dict = load_agent_settings_and_prompts(agent_path, agent_name)
    agent_settings = AgentSettings.from_dict(agent_settings_dict)
    agent_prompts = AgentPrompts.from_dict(agent_prompts_dict)

    agent_class = get_agent_class(agent_path, agent_name)
    agent_instance = agent_class(
        model_handler=model_handler,
        agent_config=agent_config,
        agent_settings=agent_settings,
        agent_prompts=agent_prompts,
        agent_path=agent_path,
    )
    agent_instance.run()


def run_merge(model: str, input_file: str, edited_file: str) -> None:
    """Initialize and run merge agent to handle file merging operations."""
    agent_config = create_agent_config(agent="merge", model=model, input_file=input_file, edited_file=edited_file)

    if model not in MODEL_CONFIGS:
        raise ValueError(f"Model {model} not found in MODEL_CONFIGS")

    model_config = MODEL_CONFIGS[model]
    model_handler = ModelFactory.create_handler(model_config)

    agent_path = get_agent_path("merge")
    agent_settings_dict, agent_prompts_dict = load_agent_settings_and_prompts(agent_path, "merge")
    agent_settings = AgentSettings.from_dict(agent_settings_dict)
    agent_prompts = AgentPrompts.from_dict(agent_prompts_dict)

    agent = AgentMerge(
        model_handler=model_handler,
        agent_config=agent_config,
        agent_settings=agent_settings,
        agent_prompts=agent_prompts,
        agent_path=agent_path,
    )
    agent.run()
