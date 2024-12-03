import os
import yaml
from jinja2 import Template
from typing import Dict, Any

from .file_utils import read_file
from .logging_utils import logger


def load_yaml(file_path: str) -> dict:
    """Load a YAML file and return its contents as a dictionary."""
    with open(file_path, "r") as f:
        return yaml.safe_load(f)


def merge_dicts(base: dict, override: dict) -> dict:
    """Merge two dictionaries recursively."""
    result = base.copy()
    for key, value in override.items():
        if isinstance(value, dict) and key in result:
            result[key] = merge_dicts(result[key], value)
        else:
            result[key] = value
    return result


def load_agent_settings_and_prompts(agent_path: str, agent: str):
    """Load agent settings and prompts from YAML files."""

    def load_agent_from_yaml(agent_path, agent_name):
        agent_file = f"{agent_path}/{agent_name}.yaml"
        if not os.path.exists(agent_file):
            raise FileNotFoundError(f"Task prompt file not found: {agent_file}")

        config = load_yaml(agent_file)
        parent = config.get("inherits")

        if parent:
            parent_settings, parent_prompts = load_agent_from_yaml(agent_path, parent)

            # Extract settings and prompts from current agent
            agent_settings = config.get("settings", {}) or {}
            agent_prompts = config.get("prompts", {}) or {}

            # Merge with parent settings and prompts
            settings = merge_dicts(parent_settings, agent_settings)
            prompts = merge_dicts(parent_prompts, agent_prompts)
        else:
            settings = config.get("settings", {}) or {}
            prompts = config.get("prompts", {}) or {}

            # Handle prefills if present in settings
            if "prefills" not in settings:
                settings["prefills"] = []

        return settings, prompts

    return load_agent_from_yaml(agent_path, agent)


def render_prompt(prompt: str, variables: Dict[str, Any]) -> str:
    """Render a prompt string using Jinja2 templating."""
    template = Template(prompt)
    rendered_prompt = template.render(**variables)
    # logger.info(f"Rendered prompt: {rendered_prompt}")
    return rendered_prompt


def get_xml_format_from_file(file: str) -> str:
    return f'<document name="{file}">\n' f"{read_file(file)}\n" f"</document>"


def get_xml_format_from_files(files: list[str]) -> str:
    return "\n".join(get_xml_format_from_file(file) for file in files) if files else None


def get_list_of_files(files: list[str] | None) -> str | None:
    if not files:  # Handles None and empty list cases
        return None

    # Filter out None values and convert all items to strings
    valid_files = [str(f) for f in files if f is not None]

    if not valid_files:  # Return None if no valid files after filtering
        return None

    return ", ".join(valid_files)
