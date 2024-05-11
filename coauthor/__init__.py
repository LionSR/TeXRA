# coauthor/__init__.py
from .process import process_file_with_claude
from .utils import (
    read_file,
    write_file,
    find_last_non_empty_line,
    extract_text_from_tags,
    check_for_massive_repetition,
)
from .claude_utils import compute_anthropic_price, model_mapping

__all__ = [
    "process_file_with_claude",
    "read_file",
    "write_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
    "compute_anthropic_price",
    "model_mapping",
]
