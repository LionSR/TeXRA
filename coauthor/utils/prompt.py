from jinja2 import Template
from typing import Any


def get_list_of_files(files: list[str] | None) -> str:
    """Convert a list of files to a comma-separated string."""
    return ", ".join(str(f) for f in (files or []) if f is not None)


def render_prompt(prompt: str, variables: dict[str, Any]) -> str:
    """Render a prompt string using Jinja2 templating."""
    template = Template(prompt)
    rendered_prompt = template.render(**variables)
    # logger.info(f"Rendered prompt: {rendered_prompt}")
    return rendered_prompt
