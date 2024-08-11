import os
import subprocess
import re
from termcolor import colored, cprint


def run_external_command(command, output_file=None, encoding="utf-8", capture_output=False):
    """
    Run an external command and handle its output.

    :param command: List containing the command and its arguments
    :param output_file: Path to the output file (if any)
    :param encoding: Encoding to use for file operations
    :param capture_output: Whether to capture and return the command output
    :return: Tuple containing (success_flag, output_or_error_message)
    """
    print("\nRunning command:", colored(" ".join(command), "green"))
    try:
        kwargs = {
            "check": True,
            "text": True,
        }
        if output_file:
            with open(output_file, "w", encoding=encoding) as file:
                subprocess.run(command, stdout=file, stderr=subprocess.PIPE, **kwargs)
            print("\nCommand completed.\nOutput saved to", colored(output_file, "blue"))
            return True, None
        elif capture_output:
            result = subprocess.run(command, capture_output=True, **kwargs)
            return True, result.stdout.strip()
        else:
            subprocess.run(command, stderr=subprocess.PIPE, **kwargs)
            return True, None
    except subprocess.CalledProcessError as e:
        error_message = f"Error running command: {e}\nError output: {e.stderr}"
        print("\n" + colored(error_message, "red"))
        return False, error_message


def get_tex_count(file_paths):
    """
    Get full statistics for LaTeX documents using the texcount Perl script.

    :param file_paths: List of paths to LaTeX files
    :return: String containing full texcount output for all files, or None if an error occurred
    """
    if not isinstance(file_paths, list):
        file_paths = [file_paths]

    all_outputs = []
    for file_path in file_paths:
        if not os.path.exists(file_path):
            cprint(f"Error: File {file_path} does not exist.", "red")
            continue

        # success, output = run_external_command(["texcount", "-merge", file_path], capture_output=True)
        success, output = run_external_command(["texcount", file_path], capture_output=True)
        if success:
            all_outputs.append(f"Tex Count Results for {file_path}:\n{output}")
        else:
            cprint(f"Error getting tex count for {file_path}", "red")

    if all_outputs:
        combined_output = "\n\n".join(all_outputs)
        cprint(f"Combined Tex Count Results:\n{combined_output}", "yellow")
        return combined_output
    return None


def handle_tex_count(kwargs, input_files):
    if kwargs.get("include_tex_count"):
        if isinstance(input_files, str):
            input_files = [input_files]
        tex_count_stats = get_tex_count(input_files)
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


def run_latexdiff(input_file, output_file, agent=None, suffix="_diff"):
    if not input_file:
        cprint("WARNING: input_file is None or empty", "yellow")
        return None

    if agent is not None and "draw" in agent:
        return None

    # Check if both input and output files contain \begin{document} and \end{document}
    with open(input_file, "r") as f:
        input_content = f.read()
    with open(output_file, "r") as f:
        output_content = f.read()

    if (
        "\\begin{document}" not in input_content
        or "\\end{document}" not in input_content
        or "\\begin{document}" not in output_content
        or "\\end{document}" not in output_content
    ):
        cprint("WARNING: One or both files do not contain \\begin{document} and \\end{document}. Skipping latexdiff.", "yellow")
        cprint(f"Input file: {input_file}, Output file: {output_file}", "yellow")
        return None

    diff_file_name = output_file.replace(".tex", f"{suffix}.tex")

    latexdiff_command = [
        "latexdiff",
        "--flatten",
        "--encoding=utf8",
        "-c",
        "PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*",
        input_file,
        output_file,
    ]

    success, _ = run_external_command(latexdiff_command, diff_file_name)
    if not success:
        return None

    process_diff_file(diff_file_name)
    process_tikzpicture_endings(diff_file_name)


def run_latexdiff_vc(input_file, commit_hash):
    if not input_file:
        cprint("WARNING: input_file is None or empty", "yellow")
        return None

    # Check if the input file contains \begin{document} and \end{document}
    with open(input_file, "r") as f:
        input_content = f.read()

    if "\\begin{document}" not in input_content or "\\end{document}" not in input_content:
        cprint("WARNING: Input file does not contain \\begin{document} and \\end{document}. Skipping latexdiff-vc.", "yellow")
        return None

    diff_file_name = input_file.replace(".tex", f"-diff{commit_hash}.tex")

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

    success, _ = run_external_command(latexdiff_vc_command)
    if not success:
        return None

    process_diff_file(diff_file_name)
    process_tikzpicture_endings(diff_file_name)


def run_latexdiff_multiple(input_files, edited_files):
    if len(input_files) != len(edited_files):
        raise ValueError("The number of input files must match the number of edited files.")

    for input_file, edited_file in zip(input_files, edited_files):
        run_latexdiff(input_file, edited_file)


def run_latexdiff_vc_multiple(input_files, commit_hash):
    for input_file in input_files:
        run_latexdiff_vc(input_file, commit_hash)


def process_diff_file(diff_file_name):
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
            if line.startswith("%!TEX root") or line.startswith("% !TEX root") or line.startswith("%! TEX root"):
                continue

            if any(pkg in line for pkg in packages_to_add_newline):
                diff_file.write("\n")

            if "\\documentclass" in line or "\\input" in line:
                add_block = False
                document_started = True
            elif ("%DIF ADD" in line or "Here is" in line) and not document_started:
                add_block = True

            if not add_block:
                diff_file.write(line)

            if "\\RequirePackage{color}" in line:
                diff_file.write("\n")

    cprint(f"Line breaks added to {diff_file_name}", "blue")


def compile_latex_to_pdf(tex_file):
    output_directory = os.path.dirname(tex_file)
    command = ["pdflatex", "-interaction=nonstopmode", f"-output-directory={output_directory}", tex_file]

    success, output = run_external_command(command, capture_output=True)

    if success:
        print(f"Compiled {tex_file} successfully.")
    else:
        cprint(f"Error compiling {tex_file}", "white", "on_red")
        print("Error message:")
        if output:
            stdout, stderr = output.split("\n", 1)
            cprint(stdout, "magenta")
            cprint(stderr, "red")
