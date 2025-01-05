"""
Utilities module for the coauthor package.
Provides a collection of helper functions for file operations, image processing,
XML handling, text replacements, and other common tasks.
"""

from .file import (
    read_file,
    write_file,
    append_file,
    delete_file,
    move_file,
    find_file,
)

from .img import (
    get_base64_encoded_image,
    single_page_pdf_to_png,
    multi_page_pdf_to_png,
    process_pdf_input,
    count_pdf_pages,
)

from .xml import (
    get_xml_format_from_file,
    get_xml_format_from_files,
    extract_text_from_tags,
    add_cdata_to_tags,
    add_cdata_to_tags_multiple,
)

from .prompt import (
    get_list_of_files,
    render_prompt,
)

from .exec import execute_command, truncate_output

from .confirmation import wrap_confirmation_prompts, CONFIRMATION_PROMPT_PATTERNS

from .replacement import (
    ReplacementCategory,
    get_all_replacements,
    get_replacements_by_category,
    applyReplacements,
    apply_replacement_regex,
)

from .repetition import check_for_massive_repetition

__all__ = [
    # File operations
    "read_file",
    "write_file",
    "append_file",
    "delete_file",
    "move_file",
    "find_file",
    "get_list_of_files",
    # Image and PDF processing
    "get_base64_encoded_image",
    "single_page_pdf_to_png",
    "multi_page_pdf_to_png",
    "process_pdf_input",
    "count_pdf_pages",
    # XML handling
    "get_xml_format_from_file",
    "get_xml_format_from_files",
    "extract_text_from_tags",
    "add_cdata_to_tags",
    "add_cdata_to_tags_multiple",
    # Text processing and replacements
    "ReplacementCategory",
    "get_all_replacements",
    "get_replacements_by_category",
    "applyReplacements",
    "apply_replacement_regex",
    "check_for_massive_repetition",
    # Prompts and confirmation
    "render_prompt",
    "wrap_confirmation_prompts",
    "CONFIRMATION_PROMPT_PATTERNS",
    # Execution
    "execute_command",
    "truncate_output",
]
