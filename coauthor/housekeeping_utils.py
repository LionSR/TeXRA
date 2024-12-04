import os
import shutil
import glob
import subprocess

from datetime import datetime

from .logging_utils import logger
from .model_config import MODEL_CONFIGS

# MUST BE EXTREMELY careful with the subtle differences and edge cases

EXCLUDED_DIRS = ["Figs", "Figures", "build", "Versions", "versions", "History", "history", "figs", "figures", "Notes"]
PACK_EXTENSIONS = [".pdf", ".tex", ".txt", ".text", ".xml", ".md"]
TEMP_EXTENSIONS = [
    ".pdf",
    ".aux",
    ".bbl",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".log",
    ".out",
    ".synctex.gz",
    ".bib",
    ".nav",
    ".run.xml",
    ".snm",
    ".toc",
    "-blx.bib",
    "Notes.bib",
]
MODELS = list(MODEL_CONFIGS.keys())

HISTORY_DIR = "History"


def get_agent_first_name_chunk(agent):
    if agent.startswith("write-"):
        return agent.split("-")[1]
    else:
        return agent.split("_")[0] if "_" in agent else agent.split("-")[0]


def get_file_patterns(base, model, agent, num_rounds=4):
    patterns = []
    for round in range(num_rounds):
        patterns.extend(
            [
                f"{base}_{agent}_r{round}_{model}",
                f"{base}_{agent}_r{round}_{model}_diff",
                f"{base}_{agent}_r{round}_{model}_diffr{round}r{round-1}",
                f"{base}_{agent}_r{round}_full_{model}",
                f"{base}_{agent}_r{round}_full_{model}_diff",
                f"{base}_{agent}_r{round}_full_{model}_diffr{round}r{round-1}",
                f"{base}_{agent}_r{round}_{model}_thinking",
            ]
        )
    return patterns


def get_folder_datetime(input_dir, file_patterns, extensions):
    most_recent_time = None
    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    mod_time = os.path.getmtime(file_path)
                    if most_recent_time is None or mod_time > most_recent_time:
                        most_recent_time = mod_time

    if most_recent_time:
        return datetime.fromtimestamp(most_recent_time).strftime("%Y%m%d%H%M")
    else:
        return datetime.now().strftime("%Y%m%d%H%M")


def delete_file(file_path):
    try:
        if os.path.isfile(file_path):
            os.remove(file_path)
            logger.info(f"Deleted file: {file_path}")
        elif os.path.isdir(file_path):
            shutil.rmtree(file_path)
            logger.info(f"Deleted dir: {file_path}")
    except PermissionError:
        logger.error(f"Cannot delete {file_path} - file in use or permission denied")
    except Exception as e:
        logger.error(f"Failed to delete {file_path}: {str(e)}")


def move_file(source, destination):
    shutil.move(source, destination)
    logger.info(f"Moved file: {source}")


def find_file(input_dir, pattern, ext=None):
    search_dirs = [os.path.join(input_dir, "build"), input_dir]
    if ext:
        file_name = f"{pattern}{ext}"
        for search_dir in search_dirs:
            file_path = os.path.join(search_dir, file_name)
            if os.path.exists(file_path):
                return file_path
    else:
        for search_dir in search_dirs:
            for file in os.listdir(search_dir):
                if file.startswith(pattern):
                    return os.path.join(search_dir, file)
    return None


def run_clean_single(model, input_file, agent):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    agent_first_name_chunk = get_agent_first_name_chunk(agent)
    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)
    file_patterns.extend([f"{base_name}_{agent_first_name_chunk}_r0_{model}_thinking", f"{base_name}_{agent_first_name_chunk}_r1_{model}_thinking"])

    extensions = TEMP_EXTENSIONS + PACK_EXTENSIONS

    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    delete_file(file_path)

    logger.info(f"Cleanup finished: {input_file}.")


def run_pack_single(model, input_file, agent, output_folder=None):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    agent_first_name_chunk = get_agent_first_name_chunk(agent)

    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)
    file_patterns.append(base_name)

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for ext in PACK_EXTENSIONS:
            file_path = find_file(input_dir, pattern, ext)
            if file_path:
                if file_path == input_file or pattern == base_name:
                    copied_files.append(file_path)
                else:
                    moved_files.append(file_path)

    # this includes the original input file, f"{base}_{agent}_r{round}_{model}", so even if no output file from llm is genereated, the output folder will still be created
    if moved_files or copied_files:
        now = get_folder_datetime(input_dir, file_patterns, PACK_EXTENSIONS)
        if output_folder is None:
            output_folder = os.path.join(input_dir, HISTORY_DIR, f"{now}_{base_name}_{agent}_{model}")
        os.makedirs(output_folder, exist_ok=True)
        for file_path in moved_files:
            move_file(file_path, output_folder)
        for file_path in copied_files:
            shutil.copy(file_path, output_folder)
            logger.info(f"Copied file: {file_path}")

        logger.info(f"Files packed to: {output_folder}")

    for pattern in file_patterns:
        for ext in TEMP_EXTENSIONS:
            file_path = find_file(input_dir, pattern, ext)
            if file_path and file_path != input_file:
                delete_file(file_path)

    logger.info(f"Packing finished: {input_file}.")
    return output_folder


def run_clean_multiple(model, input_file, input_files, agent):
    run_clean_single(model, input_file, agent)
    for f in input_files:
        run_clean_single(model, f, agent)
    logger.info("Multi-file cleanup finished")


def run_pack_multiple(model, input_file, input_files, agent, output_name_override):
    if output_name_override:
        base_name = os.path.splitext(os.path.basename(output_name_override))[0]
        output_dir = os.path.dirname(output_name_override)
    elif input_file:
        base_name = os.path.splitext(os.path.basename(input_file))[0]
        output_dir = os.path.dirname(input_file)

    agent_first_name_chunk = get_agent_first_name_chunk(agent)
    file_patterns = get_file_patterns(base_name, model, agent_first_name_chunk)

    # Add patterns for additional XML files
    additional_patterns = [f"{base_name}_{agent_first_name_chunk}_r0_{model}.xml", f"{base_name}_{agent_first_name_chunk}_r1_{model}.xml"]
    file_patterns.extend(additional_patterns)

    now = get_folder_datetime(output_dir, file_patterns, PACK_EXTENSIONS)
    common_output_folder = os.path.join(output_dir, HISTORY_DIR, f"{now}_{base_name}_multiple_{agent}_{model}")

    # Ensure the output folder exists
    os.makedirs(common_output_folder, exist_ok=True)

    # Pack input files
    for input_file in input_files:
        logger.info(f"\nPacking files to: {common_output_folder}")
        run_pack_single(model, input_file, agent, output_folder=common_output_folder)

    # Pack additional XML files
    for pattern in additional_patterns:
        file_path = os.path.join(output_dir, pattern)
        if os.path.exists(file_path):
            move_file(file_path, common_output_folder)

    logger.info(f"All files packed to: {common_output_folder}")
    return common_output_folder


def run_pack_latexdiff_vc(input_file, commit_hash, clean=False):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    if not clean:
        now = datetime.now().strftime("%Y%m%d%H%M")
        output_folder = os.path.join(input_dir, "Diffs", f"{now}_{base_name}_{commit_hash}")

    file_patterns = [f"{base_name}-diff{commit_hash}"]

    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for ext in [".tex", ".pdf"]:
            file_path = find_file(input_dir, pattern, ext)
            if file_path:
                files_to_process.append(file_path)
                for temp_ext in TEMP_EXTENSIONS:
                    temp_file = os.path.splitext(file_path)[0] + temp_ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)

    if files_to_process:
        if clean:
            for file_path in files_to_process + files_to_delete:
                delete_file(file_path)
            logger.info("Cleanup finished")
        else:  # move files to output folder
            os.makedirs(output_folder, exist_ok=True)
            for file_path in files_to_process:
                move_file(file_path, output_folder)

            for file_path in files_to_delete:
                delete_file(file_path)

            logger.info(f"Files packed to: {output_folder}")
    else:
        logger.warning("No files found to process.")


def run_pack_latexdiff_vc_multiple(input_files, commit_hash, clean=False):
    for input_file in input_files:
        run_pack_latexdiff_vc(input_file, commit_hash, clean)


def run_clean_build():
    def clean_build_dir(directory):
        build_dir = os.path.join(directory, "build")
        if os.path.isdir(build_dir):
            for item in os.listdir(build_dir):
                file_path = os.path.join(build_dir, item)
                delete_file(file_path)

    clean_build_dir(".")

    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED_DIRS]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            clean_build_dir(subdir)

    logger.info("All specified files deleted")


def run_clean_output():
    patterns = [f"*_{model}*.tex" for model in MODELS]
    patterns_build = [f"*/build/*_{model}*" for model in MODELS]

    files_to_delete = []

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in EXCLUDED_DIRS]

        for pattern in patterns:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern)))

        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    for file in set(files_to_delete):
        try:
            if os.path.exists(file):
                delete_file(file)
            else:
                logger.warning(f"Not found: {file}")
        except OSError as e:
            logger.error(f"Failed to delete {file}: {e}")

    logger.info("Cleanup finished")


def run_indent_tex():
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for file in files:
            if file.endswith(".tex"):
                tex_file = os.path.join(root, file)
                command = ["latexindent", tex_file, "-w", "-s"]
                if latexindent_config:
                    command.append(f"-l={latexindent_config}")
                subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for pattern in ["**/*.bak0", "**/indent.log"]:
        for file in glob.glob(pattern, recursive=True):
            delete_file(file)

    logger.info("All .tex files indented and temp files deleted")
