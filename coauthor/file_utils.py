from termcolor import colored
import difflib
import os
import re


def get_prompt_path(library, prompt_name):
    return os.path.join(os.path.dirname(os.path.dirname(library.__file__)), "tasks", prompt_name)


def read_file(file_path):
    if not os.path.exists(file_path):
        return ""
    with open(file_path, "r") as file:
        return file.read().strip()


def write_file(file_path, content):
    with open(file_path, "w") as file:
        file.write(content)


def append_file(file_path, content):
    with open(file_path, "a+") as file:
        file.write(content)


def find_last_non_empty_line(response):
    lines = response.split("\n")
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            return lines[i]
    return ""


def extract_text_from_tags(input_content, document_tag):
    match = re.search(rf"<{document_tag}>(.*?)</{document_tag}>", input_content, re.DOTALL)
    return match.group(1) if match else input_content


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


__all__ = [
    "get_prompt_path",
    "read_file",
    "write_file",
    "append_file",
    "find_last_non_empty_line",
    "extract_text_from_tags",
    "check_for_massive_repetition",
]
