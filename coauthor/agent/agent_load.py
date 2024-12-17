import os
import yaml
from typing import Tuple, Dict


def load_yaml(file_path: str) -> dict:
    """Load a YAML file and return its contents as a dictionary."""
    with open(file_path) as f:
        return yaml.safe_load(f)


def merge_dicts(base: dict, override: dict) -> dict:  # Core dictionaries
    """Merge two dictionaries recursively."""
    result = base.copy()
    for key, value in override.items():
        if isinstance(value, dict) and key in result:
            result[key] = merge_dicts(result[key], value)
        else:
            result[key] = value
    return result


def load_agent_from_yaml(agent_path: str, agent_name: str) -> Tuple[Dict, Dict]:
    agent_file = os.path.join(agent_path, f"{agent_name}.yaml")
    if not os.path.exists(agent_file):
        raise FileNotFoundError(f"Task prompt file not found: {agent_file}")

    config = load_yaml(agent_file)
    parent = config.get("inherits")

    if parent:
        parent_settings, parent_prompts = load_agent_from_yaml(agent_path, parent)
        agent_settings = config.get("settings", {}) or {}
        agent_prompts = config.get("prompts", {}) or {}
        settings = merge_dicts(parent_settings, agent_settings)
        prompts = merge_dicts(parent_prompts, agent_prompts)
    else:
        settings = config.get("settings", {}) or {}
        prompts = config.get("prompts", {}) or {}
        settings.setdefault("prefills", [])

    return settings, prompts


def load_agent_settings_and_prompts(agent_path: str, agent: str) -> Tuple[Dict, Dict]:
    return load_agent_from_yaml(agent_path, agent)
