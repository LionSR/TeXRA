import os
import re

from ..logger import logger
from ..utils.file import writeFile, readFile
from ..utils.replacement import getReplacementsByCategory, applyReplacementRegex
from ..utils.exec import executeCommand

from .latexindent import run_latexindent


def process_diff_file(diffFileName: str) -> None:
    """Process LaTeX diff file to fix formatting issues and apply replacements."""
    if not os.path.exists(diffFileName):
        logger.warning(f"File {diffFileName} does not exist. Skipping.")
        return None

    content = readFile(diffFileName)
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

    writeFile(diffFileName, "\n".join(processed_lines))


def process_tikzpicture_endings_diff(filePath: str) -> None:
    """Fix tikzpicture environment endings and indentation in LaTeX diff file."""
    if not os.path.exists(filePath):
        logger.warning(f"File {filePath} does not exist. Skipping.")
        return None

    content = readFile(filePath)

    # Apply tikz-specific replacements
    content = applyReplacementRegex(content, getReplacementsByCategory("tikz"), flags=re.DOTALL)

    writeFile(filePath, content)
    # logger.info(f"Tikzpicture endings fixed in {filePath}")


def run_latexdiff(inputFile: str, outputFile: str, suffix: str = "_diff", run_indent: bool = False) -> str | None:
    """Run latexdiff between two LaTeX files with optional indentation and return diff file path."""
    if not inputFile:
        logger.warning("Input file is None or empty")
        return None

    if run_indent:
        if not run_latexindent(inputFile) or not run_latexindent(outputFile):
            logger.warning("Failed to indent one or both files. Proceeding with latexdiff anyway.")

    # Check if both input and output files contain \begin{document} and \end{document}
    input_content = readFile(inputFile)
    outputContent = readFile(outputFile)
    if (
        "\\begin{document}" not in input_content
        or "\\end{document}" not in input_content
        or "\\begin{document}" not in outputContent
        or "\\end{document}" not in outputContent
    ):
        logger.warning("One or both files do not contain \\begin{document} and \\end{document}. Skipping latexdiff.")
        logger.warning(f"Input file: {inputFile}, Output file: {outputFile}")
        return None

    # Check if both files have round numbers and model names
    input_match = re.search(r"_r(\d+)_([^.]+)\.tex$", inputFile)
    output_match = re.search(r"_r(\d+)_([^.]+)\.tex$", outputFile)

    if input_match and output_match:
        first_round = input_match.group(1)
        second_round = output_match.group(1)
        first_model = input_match.group(2)
        second_model = output_match.group(2)

        # If models match, include it in the diff filename
        if first_model == second_model:
            # Get the base name up to the round number (inclusive)
            base_match = re.match(r"^(.*?_r\d+)", os.path.splitext(outputFile)[0])
            if base_match:
                diffFileName = f"{base_match.group(1)}_{second_model}_diffr{second_round}r{first_round}.tex"
            else:
                logger.warning("Failed to extract base name with round number")
                return None
        else:
            # Models don't match, use standard pattern
            base_match = re.match(r"^(.*?)_r\d+", os.path.splitext(outputFile)[0])
            if base_match:
                diffFileName = f"{base_match.group(1)}_diffr{second_round}r{first_round}.tex"
            else:
                logger.warning("Failed to extract base name")
                return None
    else:
        # Use default naming convention
        diffFileName = outputFile.replace(".tex", f"{suffix}.tex")

    latexdiff_command = [
        "latexdiff",
        "--flatten",
        "--encoding=utf8",
        "-c",
        "PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*",
        inputFile,
        outputFile,
    ]

    success, _, _ = executeCommand(latexdiff_command, diffFileName)
    if not success:
        return None

    process_diff_file(diffFileName)
    process_tikzpicture_endings_diff(diffFileName)

    return diffFileName


def run_latexdiff_vc(inputFile: str, commitHash: str) -> str | None:
    """Run latexdiff-vc on LaTeX file using specified git commit hash and return diff file path."""
    if not inputFile:
        logger.warning("Input file is None or empty")
        return None

    # Check if the input file contains \begin{document} and \end{document}
    input_content = readFile(inputFile)
    if "\\begin{document}" not in input_content or "\\end{document}" not in input_content:
        logger.warning("Input file does not contain \\begin{document} and \\end{document}. Skipping latexdiff-vc.")
        return None

    diffFileName = inputFile.replace(".tex", f"-diff{commitHash}.tex")

    latexdiff_vc_command = [
        "latexdiff-vc",
        "--encoding=utf8",
        "-c",
        "PICTUREENV=(?:picture|tikzpicture|DIFnomarkup)[\\w\\d*@]*",
        "--force",
        "--flatten",
        "--git",
        "-r",
        commitHash,
        inputFile,
    ]

    success, _, _ = executeCommand(latexdiff_vc_command)
    if not success:
        return None

    process_diff_file(diffFileName)
    process_tikzpicture_endings_diff(diffFileName)

    return diffFileName


def run_latexdiff_multiple(inputFiles: list[str], editedFiles: list[str]) -> None:
    """Run latexdiff on multiple pairs of LaTeX files in parallel."""
    if len(inputFiles) != len(editedFiles):
        logger.error("The number of input files must match the number of edited files. Stopping latexdiff.")
        return None

    for inputFile, editedFile in zip(inputFiles, editedFiles):
        _ = run_latexdiff(inputFile, editedFile)


def run_latexdiff_vc_multiple(inputFiles: list[str], commitHash: str) -> None:
    """Run latexdiff-vc on multiple LaTeX files using specified git commit hash."""
    for inputFile in inputFiles:
        _ = run_latexdiff_vc(inputFile, commitHash)


def run_latexdiff_for_round(baseFile: str, outputFile: str, round: int) -> str | None:
    """Run latexdiff between base and output LaTeX files for a specific round."""
    if baseFile and outputFile and os.path.exists(baseFile) and os.path.exists(outputFile):
        _ = run_latexdiff(baseFile, outputFile, suffix="_diff")
    else:
        logger.warning(f"Could not generate latexdiff for round {round}. Files not found: {baseFile} or {outputFile}")


def run_latexdiff_between_rounds(outputFile1: str, outputFile2: str) -> str | None:
    """Run latexdiff between two rounds of LaTeX edits and process the resulting diff."""
    if outputFile1 and outputFile2 and os.path.exists(outputFile1) and os.path.exists(outputFile2):
        first_round = re.search(r"_r(\d+)_", outputFile1).group(1)
        second_round = re.search(r"_r(\d+)_", outputFile2).group(1)
        diff_suffix = f"_diffr{second_round}r{first_round}"
        _ = run_latexdiff(outputFile1, outputFile2, suffix=diff_suffix)
    else:
        logger.warning(f"Could not generate latexdiff between rounds. Files not found: {outputFile1} or {outputFile2}")
