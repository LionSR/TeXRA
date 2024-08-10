import os
import re
from termcolor import colored, cprint
import difflib
import xml.etree.ElementTree as ET

from .file_utils import read_file, write_file


def get_output_file_name(input_file, agent, model, output_type, round):
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]
    output_type = output_type.strip(".")
    output_file = f"{file_name}_{agent_first_name_chunk}_r{round}_{model}.{output_type}"
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def check_for_massive_repetition(last_response, new_response):
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(0, len(last_response), 0, len(new_response))
    longest_matching_substring = last_response[longest_match.a : longest_match.a + longest_match.size]
    massive_repetition_detected = len(longest_matching_substring) > 1000

    if massive_repetition_detected:
        cprint(f"### repetition_ratio is {repetition_ratio}", "red")
        print(f"### Longest matching substring: {colored(longest_matching_substring, 'yellow')}")
        cprint("WARNING: Massive repetition detected. Stopping the process.", "white", "on_red")

    return massive_repetition_detected


def ensure_correct_xml_structure(file_path, document_tag):
    with open(file_path, "r+", encoding="utf-8") as file:
        content = file.read()
        if content.startswith("<scratchpad>"):
            if not content.endswith(f"</{document_tag}>"):
                if "</{document_tag}>" not in content:
                    content += f"\n</{document_tag}>"
                else:
                    # Move the closing tag to the end
                    content = re.sub(f"</{document_tag}>.*$", "", content, flags=re.DOTALL)
                    content += f"\n</{document_tag}>"
            file.seek(0)
            file.write(content)
            file.truncate()


def add_cdata_to_tags(xml_data, tags):
    for tag in tags:
        pattern = f"(<{tag}>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


def add_cdata_to_tags_multiple(xml_data, tags):
    for tag in tags:
        pattern = f"(<{tag}(?:\\s+[^>]*)?>)(.*?)(</{tag}>)"
        xml_data = re.sub(pattern, r"\1<![CDATA[\2]]>\3", xml_data, flags=re.DOTALL)
    return xml_data


# this and the next function needs to have a better mechanism for giving the post-fix tho the names of the multiple outputs
def split_scratchpad_output_xml(output_file, document_tag, thinking_tag="scratchpad", split_and_save_thinking=False):
    print(f"Splitting scratchpad output XML: {colored(output_file, 'cyan')}")

    if document_tag == "latex_documents" or document_tag == "rebuttal_letter":
        return split_multiple_scratchpad_output_xml(output_file, document_tag, thinking_tag, split_and_save_thinking)

    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.xml" if split_and_save_thinking else None
    tex_file = f"{base_name}.tex"
    print(f"TeX file: {colored(tex_file, 'cyan')}")
    if split_and_save_thinking:
        print(f"Thinking file: {colored(log_file_thinking, 'cyan')}")

    # Read the content of the output file
    output_content = read_file(output_file)

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5 and gpt-4o/4t
    output_content = output_content.replace("\\end{document>", "\\end{document}")
    output_content = output_content.replace("\\end{figure>", "\\end{figure}")
    output_content = output_content.replace("\\end{tikzpicture>", "\\end{tikzpicture}")
    output_content = output_content.replace("\\end{scope>", "\\end{scope}")
    output_content = output_content.replace("\\end{latex_document>", "</latex_document>\n")
    output_content = output_content.replace("\\end\n", "\\end{document}\n")

    # Add CDATA sections to specified tags
    tags_to_wrap = [document_tag, thinking_tag]
    output_content = add_cdata_to_tags(output_content, tags_to_wrap)

    # Wrap the content in a root element for proper XML parsing
    root_content = f"<root>{output_content}</root>"

    try:
        # Parse the XML content
        root = ET.fromstring(root_content)

        # Extract scratchpad content
        if split_and_save_thinking:
            scratchpad = root.find(thinking_tag)
            if scratchpad is not None:
                scratchpad_content = ET.tostring(scratchpad, encoding="unicode", method="text")
                write_file(log_file_thinking, f"<scratchpad>\n{scratchpad_content.strip()}\n</scratchpad>\n")

        # Extract latex document content (assuming only one)
        latex_document = root.find(document_tag)
        if latex_document is not None:
            # Get the full content of the latex document
            latex_content = ET.tostring(latex_document, encoding="unicode", method="text")
            latex_content = latex_content.strip()
            write_file(tex_file, latex_content)
        else:
            cprint(f"WARNING: No {document_tag} found in the output file.", "white", "on_red")

    except ET.ParseError as e:
        cprint(f"ERROR: Failed to parse XML content: {str(e)}", "white", "on_red")

    return tex_file


def split_multiple_scratchpad_output_xml(output_file, document_tag, thinking_tag="scratchpad", split_and_save_thinking=False):
    print(f"Splitting multiple scratchpad output XML: {colored(output_file, 'cyan')}")

    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.xml" if split_and_save_thinking else None

    if split_and_save_thinking:
        print(f"Log file: {colored(log_file_thinking, 'cyan')}")

    # Read the content of the output file
    output_content = read_file(output_file)

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5
    output_content = output_content.replace("\\end{document>", "\\end{document}")

    # Add CDATA sections to specified tags
    tags_to_wrap = [thinking_tag, "document"]
    output_content = add_cdata_to_tags_multiple(output_content, tags_to_wrap)

    # Wrap the content in a root element for proper XML parsing
    root_content = f"<root>{output_content}</root>"

    try:
        # Parse the XML content
        root = ET.fromstring(root_content)

        # Extract scratchpad content
        if split_and_save_thinking:
            scratchpad = root.find(thinking_tag)
            if scratchpad is not None:
                scratchpad_content = ET.tostring(scratchpad, encoding="unicode", method="text")
                write_file(log_file_thinking, f"<scratchpad>\n{scratchpad_content.strip()}\n</scratchpad>\n")

        # Extract latex documents content
        latex_documents = root.find(document_tag)
        if latex_documents is not None:
            output_files = []
            for doc in latex_documents.findall("document"):
                source = doc.get("name")
                content = doc.text

                if source is not None and content is not None:
                    content_text = content.strip()

                    # Extract agent name and model from the output file name
                    output_parts = os.path.basename(output_file).split("_")
                    agent = output_parts[1]
                    model = output_parts[-1].split(".")[0]

                    # Determine the round number from the output file name
                    round_match = re.search(r"_r(\d+)_", output_file)
                    round = int(round_match.group(1)) if round_match else 0

                    # Generate the output file name
                    base_name, extension = os.path.splitext(source)
                    tex_file = get_output_file_name(base_name, agent, model, extension, round=round)

                    # Write the content to the file
                    write_file(tex_file, content_text)
                    output_files.append(tex_file)
                    print(f"TeX file written: {colored(tex_file, 'cyan')}")
                else:
                    cprint(f"WARNING: Invalid document structure in {document_tag}.", "white", "on_red")

            return output_files
        else:
            cprint(f"WARNING: No {document_tag} found in the output file.", "white", "on_red")
            return []

    except ET.ParseError as e:
        cprint(f"ERROR: Failed to parse XML content: {str(e)}", "white", "on_red")
        return []
