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
from .model_utils import is_openai_model, is_anthropic_model, is_openrouter_model, compute_api_price, get_model_client, get_model_settings
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
from .log_utils import log_start, log_end, log_and_print_statistics, log_output_files
from .openai_utils import best_connection_method
from .prompt_utils import (
    load_agent_settings_and_prompts,
    get_user_vars_basic,
    update_user_vars_multiple_output,
    get_xml_format_from_files,
    load_prompt,
)
from .settings_utils import get_output_settings, get_prompt_settings
