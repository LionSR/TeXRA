from .agent_reflect import ThinkAndWrite, DirectWrite
from .arg_utils import get_common_argparser, comma_separated_list
from .figure_tools import extract_figure_paths, extract_and_compile_tikzpictures_with_labels
from .file_utils import (
    read_file,
    write_file,
    append_file,
    extract_text_from_tags,
    get_agent_path,
)
from .process import process_first_round, process_reflection_round
from .message_utils import (
    extract_response_statistics,
    initialize_messages,
    create_image_message,
    handle_openai_continuation,
    check_stop_conditions,
    print_stop_flags,
    has_end_tag,
)

from .tex_tools import run_latexdiff, run_latexdiff_vc, get_tex_count
from .output_utils import (
    check_for_massive_repetition,
    ensure_correct_xml_structure,
    split_scratchpad_output_xml,
    split_multiple_scratchpad_output_xml,
    add_cdata_to_tags,
    add_cdata_to_tags_multiple,
)
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png
from .logdb_utils import log_db_start, log_db_and_print_statistics, log_db_output_files
from .openai_utils import best_connection_method
from .prompt_utils import (
    load_agent_settings_and_prompts,
    get_xml_format_from_files,
)

from .state import State
