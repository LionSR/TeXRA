from jinja2 import Template
from typing import Any
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
