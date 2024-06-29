import os
import subprocess
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


def run_latexdiff(input_file, output_file, model=None):
    log_file_name = output_file.replace(".tex", "_log.txt")
    diff_file_name = output_file.replace(".tex", "_diff.tex")

    if model and model in input_file and model in output_file:
        diff_file_name = output_file.replace(".tex", "_diffdiff.tex")

    # Handle scratchpad content
    with open(output_file, "r") as file:
        output_content = file.read()

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5
    output_content = output_content.replace("\\end{document>", "\\end{document}")

    if "</scratchpad>" in output_content:
        with open(log_file_name, "a+") as log_file:
            log_file.write("\n<scratchpad>\n" + output_content.split("</scratchpad>")[0] + "</scratchpad>\n")

        output_content = output_content.split(
            ("<latex_document>" if "<latex_document>" in output_content else "</scratchpad>"),
            1,
        )[1].lstrip()
        with open(output_file, "w") as file:
            file.write(output_content)

    # Run latexdiff
    latexdiff_command = f"latexdiff -c 'PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*' {input_file} {output_file} > {diff_file_name}"
    print(colored(f"Running latexdiff command: {latexdiff_command}", "green"))
    os.system(latexdiff_command)
    print(colored(f"latexdiff completed. Output saved to {diff_file_name}", "blue"))

    # Process diff file
    with open(diff_file_name, "r") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w") as diff_file:
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


def run_latexdiff_vc(input_file, commit_hash):
    diff_file_name = input_file.replace(".tex", f"-diff{commit_hash}.tex")

    # Run latexdiff-vc command
    latexdiff_vc_command = f"latexdiff-vc --force --flatten --git -r {commit_hash} {input_file}"
    print(colored(f"Running latexdiff-vc command: {latexdiff_vc_command}", "green"))
    os.system(latexdiff_vc_command)
    print(colored(f"latexdiff-vc completed. Output saved to {diff_file_name}", "blue"))

    # Process diff file
    with open(diff_file_name, "r") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w") as diff_file:
        packages_to_add_newline = [
            "\\usepackage{tikz}",
            "\\usepackage{pgfplots}",
            "\\providecommand{\\DIFaddbegin}",
            "\\RequirePackage[normalem]{ulem}",
            "\\usetikzlibrary",
        ]
        for line in lines:
            if any(pkg in line for pkg in packages_to_add_newline):
                diff_file.write("\n")
            diff_file.write(line)
            if "\\RequirePackage{color}" in line:
                diff_file.write("\n")

    print(colored(f"Line breaks added to {diff_file_name}", "blue"))
