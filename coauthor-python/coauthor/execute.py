"""Execute agent tasks."""

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from .logger import logger

from .agent.agent_dataclass import AgentSetting, AgentPrompt
from .agent.agent_config import AgentConfig
from .agent.agent_load import load_agent_settings_and_prompts

from .agent.model_registry import MODEL_CONFIGS
from .agent.model_factory import ModelFactory

from .agent.BaseReflectionAgent import BaseReflectionAgent
from .agent.CoTAgent import CoTAgent
from .agent.DirectAgent import DirectAgent
from .agent.MergeAgent import MergeAgent

load_dotenv()


def getAgent_dir_from_env() -> str:
    """Get the agent directory path from environment or default location."""
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    agents_dir = os.getenv("AGENTS_DIR", f"{script_dir}/../agents")
    return agents_dir


def getAgentName(base_agent: str, outputFiles: list[str] | None = None) -> str:
    """Return agent name with '_multiple' suffix if output files exist."""
    return f"{base_agent}_multiple" if outputFiles else base_agent


def getAgentPath(agentName: str) -> str:
    """Find and return the path to agent's yaml configuration file."""
    agents_dir = Path(getAgent_dir_from_env())
    if yaml_path := next((p for p in agents_dir.rglob(f"{agentName}.yaml")), None):
        return str(yaml_path.parent)

    error_msg = f"Could not find yaml file for agent: {agentName}"
    logger.error(f"{error_msg} from {agents_dir}")
    raise ValueError(error_msg)


def createAgentConfig(**kwargs: Any) -> AgentConfig:
    """Create and return AgentConfig object from CLI kwargs, converting string lists as needed."""
    required_fields = ["model", "agent"]
    missing_fields = [field for field in required_fields if field not in kwargs]
    if missing_fields:
        raise ValueError(f"Missing required fields: {', '.join(missing_fields)}")

    # Convert comma-separated strings to lists
    list_fields = ["inputFiles", "referenceFiles", "auxiliaryFiles", "figureFiles", "outputFiles"]
    for field in list_fields:
        if isinstance(kwargs.get(field), str):
            kwargs[field] = [f.strip() for f in kwargs[field].split(",")]
        elif kwargs.get(field) is None:
            kwargs[field] = []

    return AgentConfig.from_kwargs(**kwargs)


def getAgentClass(settings: dict) -> type[BaseReflectionAgent]:
    """Return DirectAgent or CoTAgent agent class based on settings."""
    return DirectAgent if settings.get("agentType") == "direct" else CoTAgent


def run_agent(agent: str, **kwargs: Any) -> None:
    """Initialize and run the specified agent with given configuration."""
    agentName = getAgentName(agent, kwargs.get("outputFiles"))
    agentPath = getAgentPath(agentName)
    agentConfig = createAgentConfig(agent=agentName, **kwargs)

    model_name = agentConfig.model
    if model_name not in MODEL_CONFIGS:
        raise ValueError(f"Model {model_name} not found in MODEL_CONFIGS")

    modelConfig = MODEL_CONFIGS[model_name]
    # Only override useOpenRouter if it's not already True in the model config
    if not modelConfig.useOpenRouter:
        modelConfig.useOpenRouter = kwargs.get("useOpenRouter", False)

    modelHandler = ModelFactory.create_handler(modelConfig)

    agentSettingDict, agentPromptDict = load_agent_settings_and_prompts(agentPath, agentName)
    agentSetting = AgentSetting.from_dict(agentSettingDict)
    agentPrompt = AgentPrompt.from_dict(agentPromptDict)

    agent_class = getAgentClass(agentSettingDict)
    agent_instance = agent_class(
        modelHandler=modelHandler,
        agentConfig=agentConfig,
        agentSetting=agentSetting,
        agentPrompt=agentPrompt,
        agentPath=agentPath,
    )
    agent_instance.run()


def run_merge_agent(model: str, inputFile: str, editedFile: str) -> None:
    """Initialize and run merge agent to handle file merging operations."""
    agentConfig = createAgentConfig(agent="merge", model=model, inputFile=inputFile, editedFile=editedFile)

    if model not in MODEL_CONFIGS:
        raise ValueError(f"Model {model} not found in MODEL_CONFIGS")

    modelConfig = MODEL_CONFIGS[model]
    modelHandler = ModelFactory.create_handler(modelConfig)

    agentPath = getAgentPath("merge")
    agentSettingDict, agentPromptDict = load_agent_settings_and_prompts(agentPath, "merge")
    agentSetting = AgentSetting.from_dict(agentSettingDict)
    agentPrompt = AgentPrompt.from_dict(agentPromptDict)

    agent = MergeAgent(
        modelHandler=modelHandler,
        agentConfig=agentConfig,
        agentSetting=agentSetting,
        agentPrompt=agentPrompt,
        agentPath=agentPath,
    )
    agent.run()
