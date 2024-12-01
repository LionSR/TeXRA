import os
import re

from .logging_utils import logger


def get_agent_dir_from_env():
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    agents_dir = os.getenv("AGENTS_DIR", f"{script_dir}/agents")
    return agents_dir


def get_agent_path(library, prompt_name: str) -> str:
    base_path = os.path.dirname(os.path.dirname(library.__file__))
    if not prompt_name or prompt_name == ".":
        return os.path.join(base_path, "agents")
    return os.path.join(base_path, "agents", prompt_name)


def read_file(file_path: str, raise_warning: bool = True) -> str:
    if file_path is None:
        if raise_warning:
            logger.warning(f"File not provided: {file_path}")
        return ""
    elif not os.path.exists(file_path):
        if raise_warning:
            logger.warning(f"File not found: {file_path}")
        return ""
    with open(file_path, "r+", encoding="utf-8") as file:
        return file.read().strip()


def write_file(file_path: str, content: str) -> None:
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)


def append_file(file_path: str, content: str) -> None:
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(content)


def write_to_output_file(file_exists: bool, best_connector: str, new_response: str, output_file: str) -> bool:
    if not file_exists:
        logger.debug("Creating new file")
        write_file(output_file, new_response)
        file_exists = True
    else:
        logger.debug("Appending to existing file")
        append_file(output_file, best_connector + new_response)

    return file_exists


def extract_text_from_tags(input_content: str, document_tag: str) -> str:
    match = re.search(rf"<{document_tag}>(.*?)</{document_tag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content
