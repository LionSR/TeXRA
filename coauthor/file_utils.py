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

    match = re.search(
        r"<{}>(.*?)</{}>".format(document_tag, document_tag), INPUT_CONTENT, re.DOTALL
    )
    if match:
        INPUT_CONTENT = match.group(1)
    return INPUT_CONTENT


def check_for_massive_repetition(last_response, new_response):
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(
        0, len(last_response), 0, len(new_response)
    )
    longest_matching_substring = last_response[
        longest_match.a : longest_match.a + longest_match.size
    ]
    massive_repetition_detected = len(longest_matching_substring) > 1000
    if massive_repetition_detected:
        print(colored(f"### repetition_ratio is {repetition_ratio}", "red"))
        print(
            colored(
                f"### Longest matching substring: {longest_matching_substring}", "red"
            )
        )
        print("WARNING: Massive repetition detected. Stopping the process.")
    return massive_repetition_detected


def run_latexdiff(input_file, output_file, model):
    import os
    from termcolor import colored

    diff_file_name = output_file.replace(f"{model}.tex", f"diff_{model}.tex")
    latexdiff_command = f"latexdiff {input_file} {output_file} > {diff_file_name}"
    print(colored(f"Running latexdiff command: {latexdiff_command}", "green"))
    os.system(latexdiff_command)

    # Additional operations after latexdiff has finished
    print(colored(f"latexdiff completed. Output saved to {diff_file_name}", "blue"))

    # Read the diff file and add line breaks after %DIF PREAMBLE lines
    with open(diff_file_name, "r") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w") as diff_file:
        for line in lines:
            if "\\RequirePackage[normalem]{ulem}" in line:
                diff_file.write("\n")  # Add a line break before
            diff_file.write(line)
            if "\\RequirePackage{color}" in line:
                diff_file.write("\n")  # Add a line break after

    print(colored(f"Line breaks added to {diff_file_name}", "blue"))

    # Delete lines between "%DIF ADD" and "\documentclass["
    with open(diff_file_name, "r") as diff_file:
        lines = diff_file.readlines()

    with open(diff_file_name, "w") as diff_file:
        add_block = False
        for line in lines:
            if "%DIF ADD" in line:
                add_block = True
            elif "\\documentclass[" in line:
                add_block = False
                diff_file.write(line)
            elif not add_block:
                diff_file.write(line)
