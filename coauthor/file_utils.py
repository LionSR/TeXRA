import os
import re


def get_prompt_path(library, prompt_name):
    return os.path.join(os.path.dirname(os.path.dirname(library.__file__)), "tasks", prompt_name)


def read_file(file_path, raise_warning=True):
    if not os.path.exists(file_path):
        if raise_warning:
            import warnings

            warnings.warn(f"File not found: {file_path}")
        return ""
    with open(file_path, "r", encoding="utf-8") as file:
        return file.read().strip()


def write_file(file_path, content):
    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)


def append_file(file_path, content):
    with open(file_path, "a+", encoding="utf-8") as file:
        file.write(content)


def find_last_non_empty_line(response):
    lines = response.split("\n")
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            return lines[i]
    return ""


def extract_text_from_tags(input_content, document_tag):
    match = re.search(rf"<{document_tag}>(.*?)</{document_tag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content


__all__ = [
    "get_prompt_path",
    "read_file",
    "write_file",
    "append_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
]
