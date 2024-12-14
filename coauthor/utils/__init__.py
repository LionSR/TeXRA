from .file import (
    read_file,
    write_file,
    append_file,
    delete_file,
    move_file,
    find_file,
    write_to_output_file,
)

from .img import (
    get_base64_encoded_image,
    single_page_pdf_to_png,
    multi_page_pdf_to_png,
    process_pdf_input,
    page_count_pdf,
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

__all__ = [
    # File utilities
    "read_file",
    "write_file",
    "append_file",
    "delete_file",
    "move_file",
    "find_file",
    "write_to_output_file",
    "get_list_of_files",
    # Image/PDF utilities
    "get_base64_encoded_image",
    "single_page_pdf_to_png",
    "multi_page_pdf_to_png",
    "process_pdf_input",
    "page_count_pdf",
    # XML utilities
    "get_xml_format_from_file",
    "get_xml_format_from_files",
    "extract_text_from_tags",
    "add_cdata_to_tags",
    "add_cdata_to_tags_multiple",
    # Prompt utilities
    "get_list_of_files",
    "render_prompt",
]
