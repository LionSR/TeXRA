import os
import subprocess
import re
from termcolor import colored


def get_tex_count(file_path):
    """
    Get full statistics for a LaTeX document using the texcount Perl script.

    :param file_path: Path to the LaTeX file
    :return: String containing full texcount output, or None if an error occurred
    """
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist.")
        return None

    try:
        # Run texcount command with full statistics
        result = subprocess.run(["texcount", "-merge", file_path], capture_output=True, text=True, check=True)
        tex_count_output = result.stdout.strip()
        print(colored(f"Tex Count Results: {tex_count_output}", "yellow"))
        return tex_count_output
    except subprocess.CalledProcessError as e:
        print(f"Error running texcount: {e}")
        return None


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

    print(colored(f"Tikzpicture endings fixed in {file_path}", "blue"))


def run_latexdiff(input_file, output_file, task=None, model=None):
    diff_file_name = output_file.replace(".tex", "_diff.tex")

    if model and model in input_file and model in output_file:
        diff_file_name = output_file.replace(".tex", "_diffdiff.tex")

    if task is not None and "draw" in task:
        return None

    # Run latexdiff
    latexdiff_command = f"latexdiff --flatten --encoding=utf8 -c 'PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*' {input_file} {output_file} > {diff_file_name}"
    print("\nRunning latexdiff command:", colored(f"{latexdiff_command}", "green"))
    os.system(latexdiff_command)
    print("\nlatexdiff completed. Output saved to", colored(f"{diff_file_name}", "blue"))

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

    print(colored(f"Line breaks added to {diff_file_name}", "blue"))

    # Add this line at the end of the function
    process_tikzpicture_endings(diff_file_name)


def run_latexdiff_vc(input_file, commit_hash):
    diff_file_name = input_file.replace(".tex", f"-diff{commit_hash}.tex")

    # Run latexdiff-vc command
    # latexdiff_vc_command = f"latexdiff-vc --force --flatten --git -r {commit_hash} {input_file}"
    latexdiff_vc_command = f"latexdiff-vc --encoding=utf8 -c 'PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*' --force --flatten --git -r {commit_hash} {input_file}"
    print("Running latexdiff-vc command:", colored(f"{latexdiff_vc_command}", "green"))
    os.system(latexdiff_vc_command)
    print("latexdiff-vc completed. Output saved to", colored(f"{diff_file_name}", "blue"))

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
