from termcolor import colored
import difflib


def read_file(file_path):
    with open(file_path, "r") as file:
        return file.read()


def write_file(file_path, content):
    with open(file_path, "w") as file:
        file.write(content)


def append_file(file_path, content):
    with open(file_path, "a+") as file:
        file.write(content)


def find_last_non_empty_line(response):
    lines = response.split("\n")
    last_non_empty_line_index = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            last_non_empty_line_index = i
            break
    return lines[last_non_empty_line_index]


def extract_text_from_tags(INPUT_CONTENT, document_tag):
    import re

    match = re.search(r"<{}>(.*?)</{}>".format(document_tag, document_tag), INPUT_CONTENT, re.DOTALL)
    if match:
        INPUT_CONTENT = match.group(1)
    return INPUT_CONTENT


def check_for_massive_repetition(last_response, new_response):
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(0, len(last_response), 0, len(new_response))
    longest_matching_substring = last_response[longest_match.a : longest_match.a + longest_match.size]
    massive_repetition_detected = len(longest_matching_substring) > 1000
    if massive_repetition_detected:
        print(colored(f"### repetition_ratio is {repetition_ratio}", "red"))
        print(colored(f"### Longest matching substring: {longest_matching_substring}", "red"))
        print("WARNING: Massive repetition detected. Stopping the process.")
    return massive_repetition_detected


def run_latexdiff(input_file, output_file, model=None):
    import os
    from termcolor import colored

    log_file_name = output_file.replace(".tex", "_log.txt")
    diff_file_name = output_file.replace(".tex", "_diff.tex")

    if model is not None:
        if model in input_file and model in output_file:
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
    import os
    from termcolor import colored

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
