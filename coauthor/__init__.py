# coauthor/__init__.py
from .process import process_file_with_llm
from .model_utils import (
    create_response,
    extract_response_statistics,
    print_message_summary,
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
    run_latexdiff,
)

from .img_utils import get_base64_encoded_image

from .argparse_utils import get_common_argparser, get_prompt_path

__all__ = [
    "process_file_with_llm",
    "create_response",
    "extract_response_statistics",
    "print_message_summary",
    "is_openai_model",
    "is_anthropic_model",
    "read_file",
    "write_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
    "compute_api_price",
    "get_common_argparser",
    "get_prompt_path",
    "run_latexdiff",
    "get_base64_encoded_image",
]
