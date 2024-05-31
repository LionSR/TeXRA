# coauthor/__init__.py
from .process import process_file_with_llm
from .model_utils import (
    create_response,
    extract_response_statistics,
    print_summary,
    is_openai_model,
    is_anthropic_model,
    compute_api_price,
)

from .file_utils import (
    read_file,
    write_file,
    find_last_non_empty_line,
    extract_text_from_tags,
    check_for_massive_repetition,
)

__all__ = [
    "process_file_with_llm",
    "create_response",
    "extract_response_statistics",
    "print_summary",
    "is_openai_model",
    "is_anthropic_model",
    "read_file",
    "write_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
    "compute_api_price",
]
