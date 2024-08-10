import os
import re
import warnings


def get_agent_path(library, prompt_name):
    return os.path.join(os.path.dirname(os.path.dirname(library.__file__)), "agents", prompt_name)


def read_file(file_path, raise_warning=True):
    if file_path is None:
        if raise_warning:
            warnings.warn(f"File not provided: {file_path}")
        return ""
    elif not os.path.exists(file_path):
        if raise_warning:
            warnings.warn(f"File not found: {file_path}")
        return ""
    with open(file_path, "r", encoding="utf-8") as file:
        return file.read().strip()


def write_file(file_path, content):
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)


def append_file(file_path, content):
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(content)


def extract_text_from_tags(input_content, document_tag):
    match = re.search(rf"<{document_tag}>(.*?)</{document_tag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content
