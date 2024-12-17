import os
import re


from ..logger import logger
from ..utils.file import write_file, read_file
from ..utils.replacement import get_replacements_by_category, apply_replacement_regex

from .latexindent import run_latexindent
from .tex_tools import run_external_command


def run_latexdiff(input_file: str, output_file: str, agent: str | None = None, suffix: str = "_diff", run_indent: bool = False) -> str | None:
    """Run latexdiff between two LaTeX files with optional indentation and return diff file path."""
    if not input_file:
        logger.warning("Input file is None or empty")
        return None

    if agent is not None:
        if "draw" in agent:
            return None

    if run_indent:
        if not run_latexindent(input_file) or not run_latexindent(output_file):
            logger.warning("Failed to indent one or both files. Proceeding with latexdiff anyway.")

    # Check if both input and output files contain \begin{document} and \end{document}
    input_content = read_file(input_file)
    output_content = read_file(output_file)
    if (
        "\\begin{document}" not in input_content
        or "\\end{document}" not in input_content
        or "\\begin{document}" not in output_content
        or "\\end{document}" not in output_content
    ):
        logger.warning("One or both files do not contain \\begin{document} and \\end{document}. Skipping latexdiff.")
        logger.warning(f"Input file: {input_file}, Output file: {output_file}")
        return None

    # Check if both files have round numbers and model names
    input_match = re.search(r"_r(\d+)_([^.]+)\.tex$", input_file)
    output_match = re.search(r"_r(\d+)_([^.]+)\.tex$", output_file)

    if input_match and output_match:
        first_round = input_match.group(1)
        second_round = output_match.group(1)
        first_model = input_match.group(2)
        second_model = output_match.group(2)

        # If models match, include it in the diff filename
        if first_model == second_model:
            # Get the base name up to the round number (inclusive)
            base_match = re.match(r"^(.*?_r\d+)", os.path.splitext(output_file)[0])
            if base_match:
                diff_file_name = f"{base_match.group(1)}_{second_model}_diffr{second_round}r{first_round}.tex"
            else:
                logger.warning("Failed to extract base name with round number")
                return None
        else:
            # Models don't match, use standard pattern
            base_match = re.match(r"^(.*?)_r\d+", os.path.splitext(output_file)[0])
            if base_match:
                diff_file_name = f"{base_match.group(1)}_diffr{second_round}r{first_round}.tex"
            else:
                logger.warning("Failed to extract base name")
                return None
    else:
        # Use default naming convention
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

    success, _, _ = run_external_command(latexdiff_command, diff_file_name)
    if not success:
        return None

    process_diff_file(diff_file_name)
    process_tikzpicture_endings_diff(diff_file_name)

    return diff_file_name


def run_latexdiff_vc(input_file: str, commit_hash: str) -> str | None:
    """Run latexdiff-vc on LaTeX file using specified git commit hash and return diff file path."""
    if not input_file:
        logger.warning("Input file is None or empty")
        return None

    # Check if the input file contains \begin{document} and \end{document}
    input_content = read_file(input_file)
    if "\\begin{document}" not in input_content or "\\end{document}" not in input_content:
        logger.warning("Input file does not contain \\begin{document} and \\end{document}. Skipping latexdiff-vc.")
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

    success, _, _ = run_external_command(latexdiff_vc_command)
    if not success:
        return None

    process_diff_file(diff_file_name)
    process_tikzpicture_endings_diff(diff_file_name)

    return diff_file_name


def run_latexdiff_multiple(input_files: list[str], edited_files: list[str]) -> None:
    """Run latexdiff on multiple pairs of LaTeX files in parallel."""
    if len(input_files) != len(edited_files):
        logger.error("The number of input files must match the number of edited files. Stopping latexdiff.")
        return None

    for input_file, edited_file in zip(input_files, edited_files):
        _ = run_latexdiff(input_file, edited_file)


def run_latexdiff_vc_multiple(input_files: list[str], commit_hash: str) -> None:
    """Run latexdiff-vc on multiple LaTeX files using specified git commit hash."""
    for input_file in input_files:
        _ = run_latexdiff_vc(input_file, commit_hash)


def process_tikzpicture_endings_diff(file_path: str) -> None:
    """Fix tikzpicture environment endings and indentation in LaTeX diff file."""
    if not os.path.exists(file_path):
        logger.warning(f"File {file_path} does not exist. Skipping.")
        return None

    content = read_file(file_path)

    # Apply tikz-specific replacements
    content = apply_replacement_regex(content, get_replacements_by_category("tikz"), flags=re.DOTALL)

    write_file(file_path, content)
    # logger.info(f"Tikzpicture endings fixed in {file_path}")


def process_diff_file(diff_file_name: str) -> None:
    """Process LaTeX diff file to fix formatting issues and apply replacements."""
    if not os.path.exists(diff_file_name):
        logger.warning(f"File {diff_file_name} does not exist. Skipping.")
        return None

    content = read_file(diff_file_name)
    lines = content.splitlines()

    add_block = False
    PACKAGES_TO_ADD_NEWLINE = [
        "\\usepackage{tikz}",
        "\\usepackage{pgfplots}",
        "\\providecommand{\\DIFaddbegin}",
        "\\RequirePackage[normalem]{ulem}",
        "\\usetikzlibrary",
        "\\RequirePackage{color}",
    ]

    document_started = False
    processed_lines = []
    for line in lines:
        if line.startswith("%!TEX root") or line.startswith("% !TEX root") or line.startswith("%! TEX root"):
            continue

        if any(pkg in line for pkg in PACKAGES_TO_ADD_NEWLINE):
            processed_lines.append("")

        if "\\documentclass" in line or "\\input" in line:
            add_block = False
            document_started = True
        elif ("%DIF ADD" in line or "Here is" in line) and not document_started:
            add_block = True

        if not add_block:
            processed_lines.append(line)

    write_file(diff_file_name, "\n".join(processed_lines))


def run_latexdiff_for_round(base_file: str, output_file: str, agent: str, round: int) -> str | None:
    """Run latexdiff between base and output LaTeX files for a specific round."""
    if base_file and output_file and os.path.exists(base_file) and os.path.exists(output_file):
        _ = run_latexdiff(base_file, output_file, agent, suffix="_diff")
    else:
        logger.warning(f"Could not generate latexdiff for round {round}. Files not found: {base_file} or {output_file}")


def run_latexdiff_between_rounds(output_file1: str, output_file2: str, agent: str) -> str | None:
    """Run latexdiff between two rounds of LaTeX edits and process the resulting diff."""
    if output_file1 and output_file2 and os.path.exists(output_file1) and os.path.exists(output_file2):
        first_round = re.search(r"_r(\d+)_", output_file1).group(1)
        second_round = re.search(r"_r(\d+)_", output_file2).group(1)
        diff_suffix = f"_diffr{second_round}r{first_round}"
        _ = run_latexdiff(output_file1, output_file2, agent, suffix=diff_suffix)
    else:
        logger.warning(f"Could not generate latexdiff between rounds. Files not found: {output_file1} or {output_file2}")
