import os
import yaml


def load_yaml(filePath: str) -> dict:
    """Load a YAML file and return its contents as a dictionary."""
    if not os.path.exists(filePath):
        raise FileNotFoundError(f"YAML file not found: {filePath}")
    with open(filePath) as f:
        content = yaml.safe_load(f)
        return content if content else {}


def merge_dicts(base: dict, override: dict) -> dict:
    """Merge two dictionaries recursively."""
    result = base.copy()
    for key, value in override.items():
        if isinstance(value, dict) and key in result:
            result[key] = merge_dicts(result[key], value)
        else:
            result[key] = value
    return result


def load_agent_settings_and_prompts(agentPath: str, agentName: str) -> tuple[dict, dict]:
    """Load agent settings and prompts from YAML file with inheritance support."""
    agentFile = os.path.join(agentPath, f"{agentName}.yaml")
    if not os.path.exists(agentFile):
        raise FileNotFoundError(f"Task prompt file not found: {agentFile}")

    config = load_yaml(agentFile)
    parent = config.get("inherits")

    if parent:
        parentSettings, parentPrompts = load_agent_settings_and_prompts(agentPath, parent)
        agentSettings = config.get("settings", {}) or {}
        agentPrompts = config.get("prompts", {}) or {}
        settings = merge_dicts(parentSettings, agentSettings)
        prompts = merge_dicts(parentPrompts, agentPrompts)
    else:
        settings = config.get("settings", {}) or {}
        prompts = config.get("prompts", {}) or {}
        settings.setdefault("prefills", [])

    return settings, prompts
