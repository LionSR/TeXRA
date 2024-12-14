import os

from dotenv import load_dotenv
from pathlib import Path
from typing import Optional, List, Type

from .agent.agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent.agent_reflect import ThinkAndWrite, DirectWrite, BaseReflectChainAgent
from .agent.agent_merge import AgentMerge
from .agent.agent_load import load_agent_settings_and_prompts

from .logger import logger
from .model import MODEL_CONFIGS

load_dotenv()


def get_agent_dir_from_env():
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    agents_dir = os.getenv("AGENTS_DIR", f"{script_dir}/agents")
    return agents_dir


def create_agent_config(**kwargs) -> AgentConfig:
    """Create AgentConfig from CLI kwargs."""
    required_fields = ["model", "agent"]
    for field in required_fields:
        if field not in kwargs:
            raise ValueError(f"Missing required field: {field}")

    # Convert comma-separated strings to lists
    list_fields = ["input_files", "reference_files", "auxiliary_files", "figure_files", "output_files"]
    for field in list_fields:
        if isinstance(kwargs.get(field), str):
            kwargs[field] = [f.strip() for f in kwargs[field].split(",")]
        elif kwargs.get(field) is None:
            kwargs[field] = []

    return AgentConfig.from_kwargs(**kwargs)


def get_agent_class(agent_path: str, agent: str) -> Type[BaseReflectChainAgent]:
    """Determine agent class based on yaml settings."""
    settings_dict, _ = load_agent_settings_and_prompts(agent_path, agent)
    return DirectWrite if settings_dict.get("agent_type") == "direct" else ThinkAndWrite


def get_agent_name(base_agent: str, output_files: Optional[List[str]] = None) -> str:
    """Get agent name, appending _multiple if output_files exist."""
    return f"{base_agent}_multiple" if output_files else base_agent


def get_agent_path(agent_name: str) -> str:
    """Get agent path from yaml location."""
    agents_dir = Path(get_agent_dir_from_env())
    for yaml_file in agents_dir.rglob(f"{agent_name}.yaml"):
        return str(yaml_file.parent)
    logger.error(f"Could not find yaml file for agent: {agent_name} from {agents_dir}")
    raise ValueError(f"Could not find yaml file for agent: {agent_name}")


def run_agent(agent: str, **kwargs):
    """Run any agent except merge. Can be called from both CLI and Python."""
    # Determine agent name and path
    agent_name = get_agent_name(agent, kwargs.get("output_files"))
    agent_path = get_agent_path(agent_name)

    # Create config and validate
    agent_config = create_agent_config(agent=agent_name, **kwargs)
    logger.debug(f"Config: {agent_config}")

    # Get model config
    if agent_config.model not in MODEL_CONFIGS:
        raise ValueError(f"Model {agent_config.model} not found in MODEL_CONFIGS")
    model_config = MODEL_CONFIGS[agent_config.model]

    # Load agent settings and prompts
    agent_settings_dict, agent_prompts_dict = load_agent_settings_and_prompts(agent_path, agent_name)

    agent_settings = AgentSettings.from_dict(agent_settings_dict)
    agent_prompts = AgentPrompts.from_dict(agent_prompts_dict)

    # Get correct agent class and run
    agent_class = get_agent_class(agent_path, agent_name)
    agent_instance = agent_class(
        agent_config=agent_config, model_config=model_config, agent_settings=agent_settings, agent_prompts=agent_prompts, agent_path=agent_path
    )
    return agent_instance.run()


def run_merge(model: str, input_file: str, edited_file: str):
    """Run merge agent. Can be called from both CLI and Python."""
    # Create config and validate
    agent_config = create_agent_config(agent="merge", model=model, input_file=input_file, edited_file=edited_file)

    # Get model config
    if model not in MODEL_CONFIGS:
        raise ValueError(f"Model {model} not found in MODEL_CONFIGS")
    model_config = MODEL_CONFIGS[model]

    # Get agent path and load settings/prompts
    agent_path = get_agent_path("merge")
    agent_settings_dict, agent_prompts_dict = load_agent_settings_and_prompts(agent_path, "merge")

    agent_settings = AgentSettings.from_dict(agent_settings_dict)
    agent_prompts = AgentPrompts.from_dict(agent_prompts_dict)

    # Create and run merge agent
    agent = AgentMerge(
        agent_config=agent_config, model_config=model_config, agent_settings=agent_settings, agent_prompts=agent_prompts, agent_path=agent_path
    )
    return agent.run()
