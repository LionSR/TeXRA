# coauthor/__init__.py
from .process import process_first_round, process_reflection_round
from .model_utils import is_openai_model, is_anthropic_model, compute_api_price, get_model_client
from .message_utils import (
    create_response,
    extract_response_statistics,
    initialize_messages,
    create_image_message,
    handle_openai_continuation,
    check_stop_conditions,
    print_stop_flags,
    has_end_tag,
)
from .file_utils import (
    read_file,
    write_file,
    append_file,
    find_last_non_empty_line,
    extract_text_from_tags,
    get_prompt_path,
)
from .tex_tools import run_latexdiff, run_latexdiff_vc, get_tex_count
from .output_utils import (
    check_for_massive_repetition,
    get_output_file_name,
    get_output_file_name_merge,
    ensure_correct_xml_structure,
    split_scratchpad_output,
    split_scratchpad_output_xml,
)
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png
from .arg_utils import get_common_argparser, comma_separated_list
from .figure_tools import extract_figure_paths, extract_and_compile_tikzpictures_with_labels
from .log_utils import log_start, log_end, log_and_print_statistics, log_output_files
from .openai_utils import best_connection_method
from .prompt_utils import (
    load_task_settings_and_prompts,
    get_user_prefix_vars,
    format_file_content,
    get_auxiliary_files_content,
    get_additional_input_files_content,
    load_prompt,
    handle_single_input,
    handle_long_input,
    handle_multiple_input,
)
from .settings_utils import get_model_settings, get_output_settings, get_prompt_settings

__all__ = [
    "process_first_round",
    "process_reflection_round",
    "is_openai_model",
    "is_anthropic_model",
    "compute_api_price",
    "get_model_client",
    "create_response",
    "extract_response_statistics",
    "initialize_messages",
    "create_image_message",
    "handle_openai_continuation",
    "check_stop_conditions",
    "print_stop_flags",
    "has_end_tag",
    "read_file",
    "write_file",
    "append_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
    "get_prompt_path",
    "run_latexdiff",
    "run_latexdiff_vc",
    "get_tex_count",
    "get_base64_encoded_image",
    "single_page_pdf_to_png",
    "get_common_argparser",
    "comma_separated_list",
    "extract_figure_paths",
    "extract_and_compile_tikzpictures_with_labels",
    "log_start",
    "log_end",
    "log_and_print_statistics",
    "log_output_files",
    "best_connection_method",
    "load_task_settings_and_prompts",
    "get_user_prefix_vars",
    "format_file_content",
    "get_auxiliary_files_content",
    "get_additional_input_files_content",
    "split_scratchpad_output",
    "split_scratchpad_output_xml",
    "get_output_file_name",
    "get_output_file_name_merge",
    "ensure_correct_xml_structure",
    "load_prompt",
    "handle_single_input",
    "handle_long_input",
    "handle_multiple_input",
    "get_model_settings",
    "get_output_settings",
    "get_prompt_settings",
]
