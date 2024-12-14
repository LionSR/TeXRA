from dotenv import load_dotenv
from pathlib import Path
from typing import Optional, List, Type

from .logging_utils import logger
from .agent_dataclass import AgentConfig
from .agent_reflect import ThinkAndWrite, DirectWrite, BaseReflectChainAgent
from .agent_merge import AgentMerge
from .file_utils import get_agent_dir_from_env
from .prompt_utils import load_agent_settings_and_prompts

load_dotenv()


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
    raise ValueError(f"Could not find yaml file for agent: {agent_name}")


def run_agent(agent: str, **kwargs):
    """Run any agent except merge. Can be called from both CLI and Python."""
    # Determine agent name and path
    agent_name = get_agent_name(agent, kwargs.get("output_files"))
    agent_path = get_agent_path(agent_name)

    # Create config and validate
    config = create_agent_config(agent=agent_name, **kwargs)
    logger.debug(f"Config: {config}")

    # Get correct agent class and run
    agent_class = get_agent_class(agent_path, agent_name)
    agent_instance = agent_class(config, agent_path)
    return agent_instance.run()


def run_merge(model: str, input_file: str, edited_file: str):
    """Run merge agent. Can be called from both CLI and Python."""
    config = create_agent_config(agent="merge", model=model, input_file=input_file, edited_file=edited_file)
    agent = AgentMerge(config, get_agent_path("merge"))
    return agent.run()
