"""Utilities for handling prompts."""

import os
from jinja2 import Template
from typing import Any

from ..housekeeping.utils import get_agent_first_name_chunk
from ..logger import logger

from .file import read_file


def get_list_of_files(files: list[str] | None) -> str:
    """Convert a list of files to a comma-separated string."""
    return ", ".join(str(f) for f in (files or []) if f is not None)


def render_prompt(prompt: str, variables: dict[str, Any]) -> str:
    """Render a prompt string using Jinja2 templating."""
    template = Template(prompt)
    rendered_prompt = template.render(**variables)
    # logger.info(f"Rendered prompt: {rendered_prompt}")
    return rendered_prompt.strip()


def get_first_k_chars_from_document(input_file: str, k: int) -> str | None:
    """Get the first K characters from a document.

    Args:
        input_file: Path to the input file
        k: Number of characters to return

    Returns:
        First K characters from the document, stripped of whitespace, or None if file cannot be read
    """
    content = read_file(input_file)
    return content[:k].strip() if content else None


def write_prompt_to_xml(systemPrompt: str, userPrefix: str, userRequest: str, input_file: str, agent: str) -> str:
    """Write the model's input prompt to an XML file.

    Args:
        systemPrompt: The system prompt
        userPrefix: The user prefix
        userRequest: The user request
        input_file: Path to the input file
        agent: Name of the agent

    Returns:
        Path to the created XML file
    """
    # Get directory and base name from input file
    input_dir = os.path.dirname(input_file)
    input_base = os.path.splitext(os.path.basename(input_file))[0]
    agent_name = get_agent_first_name_chunk(agent)

    # Create output file path
    output_file = os.path.join(input_dir, f"{input_base}_{agent_name}_input.xml")
    logger.info(f"Writing input prompt to {output_file}")

    # Combine prompts
    full_prompt = f"\n<system>{systemPrompt}</system>\n\n{userPrefix}\n{userRequest}\n"

    # Write to file
    with open(output_file, "w") as f:
        f.write(full_prompt)

    return output_file
