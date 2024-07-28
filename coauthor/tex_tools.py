import os
import subprocess
import re
from termcolor import colored, cprint
import shutil
from datetime import datetime


def get_tex_count(file_path):
    """
    Get full statistics for a LaTeX document using the texcount Perl script.

    :param file_path: Path to the LaTeX file
    :return: String containing full texcount output, or None if an error occurred
    """
    if not os.path.exists(file_path):
        cprint(f"Error: File {file_path} does not exist.", "red")
        return None

    try:
        # Run texcount command with full statistics
        result = subprocess.run(["texcount", "-merge", file_path], capture_output=True, text=True, check=True)
        tex_count_output = result.stdout.strip()
        cprint(f"Tex Count Results: {tex_count_output}", "yellow")
        return tex_count_output
    except subprocess.CalledProcessError as e:
        cprint(f"Error running texcount: {e}", "red")
        return None



def handle_tex_count(kwargs, input_file):
    if kwargs.get("include_tex_count"):
        tex_count_stats = get_tex_count(input_file)
        if tex_count_stats:
            instruction = kwargs.get("instruction", "")
            kwargs["instruction"] = f"Tex Count Statistics:\n{tex_count_stats}\n\n{instruction}"
            

def process_tikzpicture_endings(file_path):
    """
    Process the file to fix tikzpicture endings with proper indentation.

    :param file_path: Path to the LaTeX diff file
    """
    with open(file_path, "r", encoding="utf-8") as file:
        content = file.read()

    pattern = re.compile(r"(?P<indent>[\t ]*)}\s*\\end{tikzpicture};\s*\\end{tikzpicture}")
    replacement = r"\g<indent>\\end{tikzpicture}\n\g<indent>};\n\g<indent>\\end{tikzpicture}"
    content = re.sub(pattern, replacement, content)

    with open(file_path, "w", encoding="utf-8") as file:
        file.write(content)

    cprint(f"Tikzpicture endings fixed in {file_path}", "blue")


def run_latexdiff(input_file, output_file, task=None, model=None):
    if not input_file:
        cprint("WARNING: input_file is None or empty", "yellow")
        return None

    if task is not None and "draw" in task:
        return None

    diff_file_name = output_file.replace(".tex", "_diff.tex")
    if model and model in input_file and model in output_file:
        diff_file_name = output_file.replace(".tex", "_diffdiff.tex")

    # Run latexdiff
    latexdiff_command = [
        "latexdiff",
        "--flatten",
        "--encoding=utf8",
        "-c",
        "PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*",
        input_file,
        output_file,
    ]
    print("\nRunning latexdiff command:", colored(" ".join(latexdiff_command), "green"))

    try:
        with open(diff_file_name, "w", encoding="utf-8") as diff_file:
            subprocess.run(latexdiff_command, check=True, stdout=diff_file, stderr=subprocess.PIPE, text=True)
        print("\nlatexdiff completed.\nOutput saved to", colored(diff_file_name, "blue"))
    except subprocess.CalledProcessError as e:
        print("\nError running latexdiff:", colored(f"Error running latexdiff: {e}", "red"))
        print("\nError output:", colored(f"Error output: {e.stderr}", "red"))
        return None

    # Process diff file
    with open(diff_file_name, "r", encoding="utf-8") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w", encoding="utf-8") as diff_file:
        add_block = False
        packages_to_add_newline = [
            "\\usepackage{tikz}",
            "\\usepackage{pgfplots}",
            "\\providecommand{\\DIFaddbegin}",
            "\\RequirePackage[normalem]{ulem}",
            "\\usetikzlibrary",
            "\\RequirePackage{color}",
        ]
        document_started = False
        for line in lines:
            if any(pkg in line for pkg in packages_to_add_newline):
                diff_file.write("\n")

            if "\\documentclass" in line or "\\input" in line:
                add_block = False
                document_started = True
            elif ("%DIF ADD" in line or "Here is" in line) and not document_started:
                add_block = True

            if not add_block:
                diff_file.write(line)

    cprint(f"Line breaks added to {diff_file_name}", "blue")

    # Add this line at the end of the function
    process_tikzpicture_endings(diff_file_name)


def run_latexdiff_vc(input_file, commit_hash):
    if not input_file:
        cprint("WARNING: input_file is None or empty", "yellow")
        return None

    diff_file_name = input_file.replace(".tex", f"-diff{commit_hash}.tex")

    # Run latexdiff-vc command
    latexdiff_vc_command = [
        "latexdiff-vc",
        "--encoding=utf8",
        "-c",
        "PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*",
        "--force",
        "--flatten",
        "--git",
        "-r",
        commit_hash,
        input_file,
    ]
    cprint(f"Running latexdiff-vc command: {' '.join(latexdiff_vc_command)}", "green")

    try:
        subprocess.run(latexdiff_vc_command, check=True, stderr=subprocess.PIPE, text=True)
        cprint(f"latexdiff-vc completed. Output saved to {diff_file_name}", "blue")
    except subprocess.CalledProcessError as e:
        cprint(f"Error running latexdiff-vc: {e}", "red")
        cprint(f"Error output: {e.stderr}", "red")
        return None

    # Process diff file
    with open(diff_file_name, "r", encoding="utf-8") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w", encoding="utf-8") as diff_file:
        packages_to_add_newline = [
            "\\usepackage{tikz}",
            "\\usepackage{pgfplots}",
            "\\providecommand{\\DIFaddbegin}",
            "\\RequirePackage[normalem]{ulem}",
            "\\usetikzlibrary",
            "\\RequirePackage{color}",
        ]
        for line in lines:
            if any(pkg in line for pkg in packages_to_add_newline):
                diff_file.write("\n")
            diff_file.write(line)
            if "\\RequirePackage{color}" in line:
                diff_file.write("\n")

    # Add this line at the end of the function
    process_tikzpicture_endings(diff_file_name)


def run_pack_latexdiff_vc(input_file, commit_hash, clean=False):
    base_name = os.path.splitext(os.path.basename(input_file))[0]
    input_dir = os.path.dirname(input_file)

    if not clean:
        now = datetime.now().strftime("%Y%m%d%H%M")
        output_folder = os.path.join(input_dir, "Diffs", f"{now}_{base_name}_{commit_hash}")

    file_patterns = [f"{base_name}-diff{commit_hash}{ext}" for ext in [".tex", ".pdf"]]
    delete_extensions = [
        ".aux",
        ".bbl",
        ".blg",
        ".fdb_latexmk",
        ".fls",
        ".log",
        ".out",
        ".synctex.gz",
    ]

    files_to_process = []
    files_to_delete = []

    for pattern in file_patterns:
        for search_dir in [os.path.join(input_dir, "build"), input_dir]:
            file_path = os.path.join(search_dir, pattern)
            if os.path.exists(file_path):
                files_to_process.append(file_path)
                for ext in delete_extensions:
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
        else:
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

