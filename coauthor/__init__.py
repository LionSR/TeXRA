# coauthor/__init__.py
from .process import process_file_with_llm
from .utils import (
    read_file,
    write_file,
    find_last_non_empty_line,
    extract_text_from_tags,
    check_for_massive_repetition,
    compute_api_price,
    model_mapping,
)

__all__ = [
    "process_file_with_llm",
    "read_file",
    "write_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
    "compute_api_price",
    "model_mapping",
]
