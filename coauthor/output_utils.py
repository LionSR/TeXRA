import os
import re
from termcolor import colored
from .file_utils import read_file, write_file
import difflib
import xml.etree.ElementTree as ET


def get_output_file_name(input_file, task, model, output_type, reflect=False):
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    if reflect:
        output_file = output_file.replace(f"_{model}", f"_reflect_{model}")
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


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


def ensure_correct_xml_structure(file_path, document_tag):
    with open(file_path, "r+", encoding="utf-8") as file:
        content = file.read()
        if content.startswith("<scratchpad>"):
            if not content.endswith(f"</{document_tag}>"):
                if "</{document_tag}>" not in content:
                    content += f"</{document_tag}>"
                else:
                    # Move the closing tag to the end
                    content = re.sub(f"</{document_tag}>.*$", "", content, flags=re.DOTALL)
                    content += f"</{document_tag}>"
            file.seek(0)
            file.write(content)
            file.truncate()


def split_scratchpad_output(output_file, document_tag="latex_document"):
    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.txt"
    tex_file = f"{base_name}.tex"
    print(f"Log file: {colored(log_file_thinking, 'cyan')}")
    print(f"TeX file: {colored(tex_file, 'cyan')}")

    output_content = read_file(output_file)

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5
    # do not change this line
    output_content = output_content.replace("\\end{document>", "\\end{document}")

    if "</scratchpad>" in output_content:
        scratchpad_content, document_content = output_content.split("</scratchpad>", 1)

        if "<scratchpad>" in scratchpad_content:
            scratchpad_content = scratchpad_content.split("<scratchpad>", 1)[1]

        write_file(log_file_thinking, f"<scratchpad>\n{scratchpad_content.strip()}\n</scratchpad>\n")

        document_content = document_content.split(("<" + document_tag + ">" if "<" + document_tag + ">" in document_content else ""), 1)[1].lstrip()

        # Remove the closing document tag if present
        document_content = document_content.replace(f"</{document_tag}>", "").strip()

        write_file(tex_file, document_content)
    else:
        # If there's no scratchpad, write the entire content to the tex file
        document_content = output_content.split(("<" + document_tag + ">" if "<" + document_tag + ">" in output_content else ""), 1)[1].lstrip()
        document_content = document_content.replace(f"</{document_tag}>", "").strip()
        write_file(tex_file, document_content)

    # Remove the original .text file
    # os.remove(output_file)

    return tex_file


def split_scratchpad_output_xml(output_file, document_tag="latex_document"):
    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.txt"
    tex_file = f"{base_name}.tex"
    print(f"Log file: {colored(log_file_thinking, 'cyan')}")
    print(f"TeX file: {colored(tex_file, 'cyan')}")

    # Read the content of the output file
    output_content = read_file(output_file)

    # Wrap the content in a root element for proper XML parsing
    root_content = f"<root>{output_content}</root>"

    # Parse the XML content
    root = ET.fromstring(root_content)

    # Extract scratchpad content
    scratchpad_elements = root.findall(".//scratchpad")
    scratchpad_content = "\n".join(ET.tostring(elem, encoding="unicode") for elem in scratchpad_elements)

    if scratchpad_content:
        write_file(log_file_thinking, scratchpad_content)

    # Extract latex document content
    latex_document = root.find(f".//{document_tag}")
    if latex_document is not None:
        # Remove any nested scratchpad elements from the latex document
        for scratchpad in latex_document.findall(".//scratchpad"):
            latex_document.remove(scratchpad)

        # Get the text content of the latex document, excluding the document_tag itself
        latex_content = "".join(latex_document.itertext()).strip()
        write_file(tex_file, latex_content)
    else:
        print(f"Warning: No {document_tag} found in the output file.")
        # If no latex document is found, write the entire content (excluding scratchpads) to the tex file
        full_content = "".join(root.itertext()).strip()
        write_file(tex_file, full_content)

    # Remove the original .text file
    # os.remove(output_file)

    return tex_file
