# coauthor/__init__.py
from .process import process_first_round, process_reflection_round
from .model_utils import is_openai_model, is_anthropic_model, compute_api_price

from .message_utils import (
    create_response,
    extract_response_statistics,
)

from .file_utils import (
    read_file,
    write_file,
    find_last_non_empty_line,
    extract_text_from_tags,
    check_for_massive_repetition,
)

from .tex_tools import run_latexdiff

from .img_utils import get_base64_encoded_image

from .arg_utils import get_common_argparser

from .file_utils import get_prompt_path

__all__ = [
    "process_first_round",
    "create_response",
    "extract_response_statistics",
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
