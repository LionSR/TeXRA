import os
import difflib
from termcolor import colored
from .file_utils import read_file, write_file, append_file


def get_output_file_name(input_file, task, model, output_type, reflect=False):
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    if reflect:
        output_file = output_file.replace(f"_{model}", f"_reflect_{model}")
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def split_scratchpad_output(output_file, document_tag="latex_document"):
    _, extension = os.path.splitext(output_file)
    log_file_thinking = output_file.replace(f"{extension}", "_thinking.txt")
    print(f"Log file: {colored(log_file_thinking, 'cyan')}")
    output_content = read_file(output_file)

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5
    # do not change this line
    output_content = output_content.replace("\\end{document>", "\\end{document}")

    if "</scratchpad>" in output_content:
        if "<scratchpad>" in output_content:
            append_file(log_file_thinking, output_content.split("</scratchpad>")[0] + "</scratchpad>\n")
        else:
            append_file(log_file_thinking, "<scratchpad>\n" + output_content.split("</scratchpad>")[0] + "</scratchpad>\n")

        output_content = output_content.split(
            ("<" + document_tag + ">" if "<" + document_tag + ">" in output_content else "</scratchpad>"),
            1,
        )[1].lstrip()
        write_file(output_file, output_content)

    return output_content


def get_output_file_name_merge(input_file, edited_file):
    input_dir = os.path.dirname(input_file)
    input_base, _ = os.path.splitext(os.path.basename(input_file))
    edited_base, _ = os.path.splitext(os.path.basename(edited_file))

    parts = edited_base.split("_")
    task = parts[1]  # Assuming the task is always the second part

    if "reflect" in parts:
        model = parts[-1]
        output = f"{input_base}_{task}_reflect_full_{model}.tex"
    else:
        model = parts[-1]
        output = f"{input_base}_{task}_full_{model}.tex"

    output = os.path.join(input_dir, output)
    print(f"Merge output file: {colored(output, 'cyan')}")
    return output


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
