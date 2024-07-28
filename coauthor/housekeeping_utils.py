import os
import shutil
import glob
import subprocess
from datetime import datetime
from termcolor import cprint

# some refactoring work can be done to the functions here by creating common utility functions. MUST BE EXTREMELY careful with the subtle differences and edge cases

excluded_dirs = {"Figs", "Figures", "build", "Versions", "versions", "figs", "figures", "Notes"}

pack_extensions = [".pdf", ".tex", ".txt", ".text", ".xml"]

temp_extensions = [".pdf", ".aux", ".bbl", ".blg", ".fdb_latexmk", ".fls", ".log", ".out", ".synctex.gz", ".bib"]


def get_first_task_chunk(task):
    if task.startswith("write-"):
        return task.split("-")[1]
    else:
        return task.split("_")[0] if "_" in task else task.split("-")[0]


def get_file_patterns(base, model, task, reflect):
    patterns = [f"{base}_{task}_{model}", f"{base}_{task}_{model}_diff", f"{base}_{task}_full_{model}", f"{base}_{task}_full_{model}_diff"]
    if reflect and reflect != "False":
        patterns.extend(
            [
                f"{base}_{task}_reflect_{model}",
                f"{base}_{task}_reflect_{model}_diff",
                f"{base}_{task}_reflect_{model}_diffdiff",
                f"{base}_{task}_reflect_full_{model}",
                f"{base}_{task}_reflect_full_{model}_diff",
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


def run_clean_single(model, input_file, reflect, task):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    first_task_chunk = get_first_task_chunk(task)
    file_patterns = get_file_patterns(base_name, model, first_task_chunk, reflect)
    file_patterns.extend([f"{base_name}_{first_task_chunk}_{model}_thinking", f"{base_name}_{first_task_chunk}_reflect_{model}_thinking"])

    extensions = temp_extensions + pack_extensions

    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    try:
                        if os.path.isfile(file_path):
                            os.remove(file_path)
                            print(f"Deleted: {file_path}")
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                            print(f"Deleted directory: {file_path}")
                    except PermissionError:
                        cprint(f"WARNING: Unable to delete {file_path}. It may be in use or you may not have permission.", "white", "on_red")
                    except Exception as e:
                        cprint(f"WARNING: Error deleting {file_path}: {str(e)}", "white", "on_red")

    print(f"Cleanup complete for {input_file}.")


def run_pack_single(model, input_file, reflect, task, output_folder=None):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    first_task_chunk = get_first_task_chunk(task)

    file_patterns = get_file_patterns(base_name, model, first_task_chunk, reflect)
    file_patterns.extend([f"{base_name}_{first_task_chunk}_{model}_thinking", f"{base_name}_{first_task_chunk}_reflect_{model}_thinking"])
    file_patterns.append(base_name)

    moved_files = []
    copied_files = []
    for pattern in file_patterns:
        for ext in pack_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    if file_path == input_file or pattern == base_name:
                        copied_files.append(file_path)
                    else:
                        moved_files.append(file_path)
                    break

    if moved_files or copied_files:
        now = get_folder_datetime(input_dir, file_patterns, pack_extensions)
        if output_folder is None:
            output_folder = os.path.join(input_dir, "Versions", f"{now}_{base_name}_{task}_{model}")
        os.makedirs(output_folder, exist_ok=True)
        for file_path in moved_files:
            shutil.move(file_path, output_folder)
            print(f"Moved: {file_path}")
        for file_path in copied_files:
            shutil.copy(file_path, output_folder)
            print(f"Copied: {file_path}")

        print(f"Files packed into {output_folder}")

    for pattern in file_patterns:
        for ext in temp_extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path) and file_path != input_file:
                    os.remove(file_path)
                    print(f"Deleted: {file_path}")

    print(f"Packing complete for {input_file}.")
    return output_folder


def run_clean_multiple(model, input_files, reflect, task):
    for input_file in input_files:
        run_clean_single(model, input_file, reflect, task)
    print("\nCleanup complete for multiple files.")


def run_pack_multiple(model, input_files, reflect, task, output_name_override):
    base_name = os.path.splitext(os.path.basename(output_name_override))[0]
    output_dir = os.path.dirname(output_name_override)

    first_task_chunk = get_first_task_chunk(task)
    file_patterns = get_file_patterns(base_name, model, first_task_chunk, reflect)

    # Add patterns for additional XML files
    additional_patterns = [f"{base_name}_{first_task_chunk}_{model}.xml", f"{base_name}_{first_task_chunk}_reflect_{model}.xml"]
    file_patterns.extend(additional_patterns)

    now = get_folder_datetime(output_dir, file_patterns, pack_extensions)
    common_output_folder = os.path.join(output_dir, "Versions", f"{now}_{base_name}_multiple_{task}_{model}")

    # Ensure the output folder exists
    os.makedirs(common_output_folder, exist_ok=True)

    # Pack input files
    for input_file in input_files:
        print(f"\nPacking {input_file} into {common_output_folder}")
        run_pack_single(model, input_file, reflect, task, output_folder=common_output_folder)

    # Pack additional XML files
    for pattern in additional_patterns:
        file_path = os.path.join(output_dir, pattern)
        if os.path.exists(file_path):
            shutil.move(file_path, common_output_folder)
            print(f"Moved xml file: {file_path}")

    print(f"All files packed into {common_output_folder}")
    return common_output_folder


def run_pack_latexdiff_vc(input_file, commit_hash, clean=False):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    if not clean:
        # this needs to updated to use get_folder_datetime
        now = datetime.now().strftime("%Y%m%d%H%M")
        output_folder = os.path.join(input_dir, "Diffs", f"{now}_{base_name}_{commit_hash}")

    file_patterns = [f"{base_name}-diff{commit_hash}{ext}" for ext in [".tex", ".pdf"]]

    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                files_to_process.append(file_path)
                for ext in temp_extensions:
                    temp_file = os.path.splitext(file_path)[0] + ext
                    if os.path.exists(temp_file):
                        files_to_delete.append(temp_file)
                break

    if files_to_process:
        if clean:
            for file_path in files_to_process + files_to_delete:
                os.remove(file_path)
                cprint(f"Deleted: {file_path}", "yellow")
            cprint("Cleanup complete.", "green")
        else:  # move files to output folder
            os.makedirs(output_folder, exist_ok=True)
            for file_path in files_to_process:
                shutil.move(file_path, output_folder)
                cprint(f"Moved: {file_path}", "blue")

            for file_path in files_to_delete:
                os.remove(file_path)
                cprint(f"Deleted: {file_path}", "yellow")

            cprint(f"Files packed into {output_folder}", "green")
    else:
        cprint("No files found to process.", "yellow")


def run_pack_latexdiff_vc_multiple(input_files, commit_hash, clean=False):
    for input_file in input_files:
        run_pack_latexdiff_vc(input_file, commit_hash, clean)


def run_clean_build():
    excluded_dirs = {"Figs", "Figures", "build", "Versions", "versions", "figs", "figures", "Notes"}

    def clean_build_dir(directory):
        build_dir = os.path.join(directory, "build")
        if os.path.isdir(build_dir):
            for item in os.listdir(build_dir):
                file_path = os.path.join(build_dir, item)
                if os.path.isfile(file_path):
                    os.remove(file_path)
                    print(f"Deleted: {file_path}")
                elif os.path.isdir(file_path):
                    shutil.rmtree(file_path)
                    print(f"Deleted directory: {file_path}")

    clean_build_dir(".")

    for root, dirs, _ in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]
        for dir in dirs:
            subdir = os.path.join(root, dir)
            clean_build_dir(subdir)

    print("All specified files have been deleted.")


def run_clean_output():
    models = ["opus", "sonnet", "sonnet+", "haiku", "gpt4t", "gpt4o", "gpt4o-"]

    patterns = [f"*_{model}*.tex" for model in models]
    patterns_build = [f"*/build/*_{model}*" for model in models]

    files_to_delete = []

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d.lower() not in excluded_dirs]

        for pattern in patterns:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern)))

        for pattern in patterns_build:
            files_to_delete.extend(glob.glob(os.path.join(root, pattern), recursive=True))

    for file in set(files_to_delete):
        try:
            if os.path.exists(file):
                os.remove(file)
                print(f"Deleted: {file}")
            else:
                print(f"File not found: {file}")
        except OSError as e:
            print(f"Error deleting {file}: {e}")

    print("Cleanup complete.")


def run_indent_tex():
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")

    for root, dirs, files in os.walk(".", topdown=True):
        dirs[:] = [d for d in dirs if d not in excluded_dirs]
        for file in files:
            if file.endswith(".tex"):
                tex_file = os.path.join(root, file)
                command = ["latexindent", tex_file, "-w", "-s"]
                if latexindent_config:
                    command.append(f"-l={latexindent_config}")
                subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    for pattern in ["**/*.bak0", "**/indent.log"]:
        for file in glob.glob(pattern, recursive=True):
            os.remove(file)

    print("All .tex files have been indented and temporary files have been deleted.")
