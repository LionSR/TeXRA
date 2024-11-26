import os
import re

from .logging_utils import logger


def get_common_env(model):
    if model is None:
        model = os.getenv("MODEL", "sonnet+")
    script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_dir = os.getenv("PROMPT_DIR", f"{script_dir}/agents")
    return model, script_dir, prompt_dir


def get_agent_path(library, prompt_name: str) -> str:
    return os.path.join(os.path.dirname(os.path.dirname(library.__file__)), "agents", prompt_name)


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
