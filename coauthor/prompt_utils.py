import os
import xml.etree.ElementTree as ET
from jinja2 import Template
from typing import Dict, Any
from .logging_utils import logger
from .file_utils import read_file


def load_xml(file_path):
    tree = ET.parse(file_path)
    return tree.getroot()


def merge_dicts(base, override):
    result = base.copy()
    for key, value in override.items():
        if isinstance(value, dict) and key in result:
            result[key] = merge_dicts(result[key], value)
        else:
            result[key] = value
    return result


def load_agent_settings_and_prompts(agent_path, agent):
    def load_agent_from_xml(agent_path, agent_name):
        agent_prompt_file = f"{agent_path}/agent_{agent_name}.xml"
        if not os.path.exists(agent_prompt_file):
            raise FileNotFoundError(f"Task prompt file not found: {agent_prompt_file}")

        root = load_xml(agent_prompt_file)
        parent = root.get("inherits")

        if parent:
            parent_settings, parent_prompts = load_agent_from_xml(agent_path, parent)
            agent_settings = {child.tag: child.text for child in root.find("settings") or []}
            agent_prompts = {child.tag: child.text.strip() for child in root.find("prompts") or []}

            # Handle prefills
            prefills_elem = root.find("settings/prefills")
            if prefills_elem is not None:
                agent_settings["prefills"] = [prefill.text for prefill in prefills_elem.findall("prefill")]

            settings = merge_dicts(parent_settings, agent_settings)
            prompts = merge_dicts(parent_prompts, agent_prompts)
        else:
            settings = {child.tag: child.text for child in root.find("settings")}
            prompts = {child.tag: child.text.strip() for child in root.find("prompts")}

            # Handle prefills
            prefills_elem = root.find("settings/prefills")
            if prefills_elem is not None:
                settings["prefills"] = [prefill.text for prefill in prefills_elem.findall("prefill")]

        return settings, prompts

    return load_agent_from_xml(agent_path, agent)


def get_xml_format_from_file(file):
    return f'<document name="{file}">\n' f"{read_file(file)}\n" f"</document>"


def get_xml_format_from_files(files):
    return "\n".join(get_xml_format_from_file(file) for file in files) if files else ""


def load_prompt(prompt_type: str, prompt_settings: Dict[str, Any]) -> str:
    """Load and return a prompt string from settings."""
    logger.debug(f"Loading prompt: {prompt_type}")
    prompt = prompt_settings.get(f"{prompt_type}_prompt", "")
    logger.info(f"Loaded prompt: {prompt_type}")
    logger.debug(f"{prompt_type}: {prompt}")
    return prompt


def render_prompt(prompt: str, variables: Dict[str, Any]) -> str:
    """Render a prompt string using Jinja2 templating."""
    template = Template(prompt)
    return template.render(**variables)
