from .agent_merge import AgentMerge
from .agent_reflect import ThinkAndWrite, DirectWrite
from .agent_run import run_agent, run_merge
from .arg_utils import comma_separated_list, get_common_argparser
from .agent_dataclass import AgentConfig, AgentPrompts, AgentSettings
from .figure_tools import extract_and_compile_tikzpictures_with_labels, extract_figure_paths_from_latex
from .file_utils import (
    append_file,
    extract_text_from_tags,
    get_agent_dir_from_env,
    get_agent_path,
    read_file,
    write_file,
    write_to_output_file,
)
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png
from .logdb_utils import logdb_and_print_statistics, logdb_output_files, logdb_start
from .text_connection import best_connection_method
from .output_utils import (
    add_cdata_to_tags,
    add_cdata_to_tags_multiple,
    check_for_massive_repetition,
    ensure_correct_xml_structure,
    split_multiple_scratchpad_output_xml,
    split_scratchpad_output_xml,
)
from .prompt_utils import (
    get_xml_format_from_files,
    load_agent_settings_and_prompts,
)
from .state import State
from .tex_tools import get_tex_count, run_latexdiff, run_latexdiff_vc
