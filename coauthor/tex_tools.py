import os
import subprocess
import re
import glob

from .file_utils import write_file, read_file
from .logging_utils import logger
from .replacement_utils import get_replacements_by_category, apply_replacement_regex


def run_external_command(
    command: list[str], output_file: str = None, encoding: str = "utf-8", capture_output: bool = True
) -> tuple[bool, str | None, str | None]:
    """Run an external command and handle its output.

    Args:
        command: List containing the command and its arguments
        output_file: Path to the output file (if any)
        encoding: Encoding to use for file operations
        capture_output: Whether to capture and return the command output

    Returns:
        Tuple[bool, Optional[str], Optional[str]]: (success_flag, output_message, error_message)
    """
    logger.info("\nRunning command: " + " ".join(command))

    def truncate_output(text, max_chars=150):
        if text and len(text) > max_chars:
            return "..." + text[-max_chars:]
        return text

    try:
        result = subprocess.run(command, text=True, capture_output=capture_output, encoding=encoding)
        if output_file:
            if result.returncode != 0:
                logger.error(f"\nCommand failed with return code {result.returncode}")
                return False, None, result.stderr.strip()
            write_file(output_file, result.stdout)
            logger.info("\nCommand completed.\nOutput saved to " + output_file)
            return True, None, None
        else:
            if result.returncode == 0:
                return True, truncate_output(result.stdout.strip()), truncate_output(result.stderr.strip())
            else:
                return False, truncate_output(result.stdout.strip()), truncate_output(result.stderr.strip())
    except subprocess.CalledProcessError as e:
        error_message = "Error running command:\n"
        if hasattr(e, "stderr") and e.stderr:
            error_message += f"\nStderr:\n{truncate_output(e.stderr)}"
        logger.error("\n" + error_message)
        return False, None, error_message


def get_tex_count(file_paths: list[str] | str, merge: bool = False) -> str | None:
    """
    Get full statistics for LaTeX documents using the texcount Perl script.

    :param file_paths: List of paths to LaTeX files
    :param merge: Whether to merge included files in the count
    :return: String containing full texcount output for all files, or None if an error occurred
    """
    if not isinstance(file_paths, list):
        file_paths = [file_paths]

    all_outputs = []
    for file_path in file_paths:
        if not os.path.exists(file_path):
            logger.warning(f"Warning: File {file_path} does not exist.")
            continue

        if ".tex" not in file_path:
            logger.warning(f"Error: File {file_path} is not a LaTeX file. Skipping.")
            continue

        command = ["texcount"]
        if merge:
            command.append("-merge")
        command.append(file_path)

        success, stdout, stderr = run_external_command(command, capture_output=True)
        if success:
            all_outputs.append(f"Tex Count Results for {file_path}:\n{stdout}")
        else:
            logger.error(f"Error getting tex count for {file_path}")
            logger.error(f"Stdout: {stdout}")
            logger.error(f"Stderr: {stderr}")
    if all_outputs:
        combined_output = "\n\n".join(all_outputs)
        logger.info(f"Combined Tex Count Results:\n{combined_output}")
        return combined_output
    return None


def compile_latex_to_pdf(tex_file: str) -> bool:
    output_directory = os.path.dirname(tex_file)
    command = ["pdflatex", "-interaction=nonstopmode", "-output-directory=" + output_directory, tex_file]

    try:
        success, stdout, stderr = run_external_command(command, capture_output=True)
        if success:
            logger.info(f"Compiled {tex_file} successfully.")
            return True
        else:
            logger.error(f"Error compiling {tex_file}")
            return False
    except ValueError as e:
        logger.error(f"Error compiling {tex_file}: {str(e)}")
        return False


def process_tikzpicture_endings_diff(file_path: str) -> None:
    """
    Process the file to fix tikzpicture endings with proper indentation.

    :param file_path: Path to the LaTeX diff file
    """
    if not os.path.exists(file_path):
        logger.warning(f"File {file_path} does not exist. Skipping.")
        return None

    content = read_file(file_path)

    # Apply tikz-specific replacements
    content = apply_replacement_regex(content, get_replacements_by_category("tikz"), flags=re.DOTALL)

    write_file(file_path, content)
    # logger.info(f"Tikzpicture endings fixed in {file_path}")


def run_latexindent(file_path: str) -> bool:
    latexindent_config = os.environ.get("LATEXINDENT_CONFIG")
    command = ["latexindent", file_path, "-w", "-s"]
    if latexindent_config:
        command.append(f"-l={latexindent_config}")

    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        logger.info(f"Indented {file_path}")

        # Clean up backup files
        backup_files = glob.glob(f"{file_path}.bak[0-9]*") + glob.glob(f"{file_path}.bak")
        for backup_file in backup_files:
            try:
                os.remove(backup_file)
                logger.info(f"Removed backup file: {backup_file}")
            except OSError as e:
                logger.warning(f"Error removing backup file {backup_file}: {e}")

        # Remove indent.log if it exists
        indent_log = os.path.join(os.path.dirname(file_path), "indent.log")
        if os.path.exists(indent_log):
            try:
                os.remove(indent_log)
                logger.info("Removed indent.log")
            except OSError as e:
                logger.warning(f"Error removing indent.log: {e}")

        return True
    except subprocess.CalledProcessError:
        logger.error(f"Error indenting {file_path}")
        return False


def run_latexdiff(input_file: str, output_file: str, agent: str | None = None, suffix: str = "_diff", run_indent: bool = False) -> str | None:
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
    if len(input_files) != len(edited_files):
        logger.error("The number of input files must match the number of edited files. Stopping latexdiff.")
        return None

    for input_file, edited_file in zip(input_files, edited_files):
        _ = run_latexdiff(input_file, edited_file)


def run_latexdiff_vc_multiple(input_files: list[str], commit_hash: str) -> None:
    for input_file in input_files:
        _ = run_latexdiff_vc(input_file, commit_hash)


def process_diff_file(diff_file_name: str) -> None:
    """Process the LaTeX diff file to fix formatting issues."""
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
    if base_file and output_file and os.path.exists(base_file) and os.path.exists(output_file):
        _ = run_latexdiff(base_file, output_file, agent, suffix="_diff")
    else:
        logger.warning(f"Could not generate latexdiff for round {round}. Files not found: {base_file} or {output_file}")


def run_latexdiff_between_rounds(output_file1: str, output_file2: str, agent: str) -> str | None:
    if output_file1 and output_file2 and os.path.exists(output_file1) and os.path.exists(output_file2):
        first_round = re.search(r"_r(\d+)_", output_file1).group(1)
        second_round = re.search(r"_r(\d+)_", output_file2).group(1)
        diff_suffix = f"_diffr{second_round}r{first_round}"
        _ = run_latexdiff(output_file1, output_file2, agent, suffix=diff_suffix)
    else:
        logger.warning(f"Could not generate latexdiff between rounds. Files not found: {output_file1} or {output_file2}")
