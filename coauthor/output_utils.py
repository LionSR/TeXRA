import os
import re
from .logging_utils import logger
import difflib
import xml.etree.ElementTree as ET


from .file_utils import read_file, write_file, append_file
from .replacement_utils import get_replacements_by_category, apply_replacements


def get_output_file_name(input_file, agent, model, output_ext, round):
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]
    output_file = f"{file_name}_{agent_first_name_chunk}_r{round}_{model}.{output_ext}"
    logger.debug(f"Output file: {output_file}")
    return output_file


def write_to_output_file(file_exists, best_connector, new_response, output_file):
    if not file_exists:
        logger.debug("Creating new file")
        write_file(output_file, new_response)
        file_exists = True
    else:
        logger.debug("Appending to existing file")
        append_file(output_file, best_connector + new_response)

    return file_exists


def check_for_massive_repetition(last_response, new_response):
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(0, len(last_response), 0, len(new_response))
    longest_matching_substring = last_response[longest_match.a : longest_match.a + longest_match.size]
    massive_repetition_detected = len(longest_matching_substring) > 1000

    if massive_repetition_detected:
        logger.error(f"Repetition ratio: {repetition_ratio}")
        logger.error(f"Longest matching substring: {longest_matching_substring}")
        logger.error("Massive repetition detected - stopping process.")

    return massive_repetition_detected


def ensure_correct_xml_structure(file_path, document_tag):
    logger.debug(f"Ensuring correct XML structure: {file_path}")
    with open(file_path, "r+", encoding="utf-8") as file:
        content = file.read()
        if content.startswith("<scratchpad>") or content.startswith("<rebuttal_letter>"):
            if not content.endswith(f"</{document_tag}>"):
                if "</{document_tag}>" not in content:
                    content += f"\n</{document_tag}>"
                else:
                    # Move the closing tag to the end
                    content = re.sub(f"</{document_tag}>.*$", "", content, flags=re.DOTALL)
                    content += f"\n</{document_tag}>"

            # Apply replacements from centralized utilities
            content = apply_replacements(content, get_replacements_by_category("latex_xml"))
            content = apply_replacements(content, get_replacements_by_category("scratchpad_xml"))

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
    logger.debug(f"Splitting scratchpad output XML: {output_file}")

    if document_tag in ["latex_documents", "rebuttal_letter"]:
        return split_multiple_scratchpad_output_xml(output_file, document_tag, thinking_tag, split_and_save_thinking)

    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.xml" if split_and_save_thinking else None
    tex_file = f"{base_name}.tex"
    logger.debug(f"TeX file: {tex_file}")
    if split_and_save_thinking:
        logger.debug(f"Thinking file: {log_file_thinking}")

    # Read the content of the output file
    output_content = read_file(output_file)

    # Apply replacements
    output_content = apply_replacements(output_content, get_replacements_by_category("latex_xml"))
    output_content = apply_replacements(output_content, get_replacements_by_category("scratchpad_xml"))

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
            latex_document = ET.tostring(latex_document, encoding="unicode", method="text")
            latex_document = latex_document.strip()
            write_file(tex_file, latex_document)
        else:
            logger.error(f"No {document_tag} found in output file.")

    except ET.ParseError as e:
        logger.error(f"Failed to parse XML content: {str(e)}")

    return tex_file


def split_multiple_scratchpad_output_xml(output_file, document_tag, thinking_tag="scratchpad", split_and_save_thinking=False):
    logger.debug(f"Splitting multiple scratchpad output XML: {output_file}")

    base_name, extension = os.path.splitext(output_file)
    log_file_thinking = f"{base_name}_thinking.xml" if split_and_save_thinking else None

    if split_and_save_thinking:
        logger.debug(f"Log file: {log_file_thinking}")

    # Read the content of the output file
    output_content = read_file(output_file)

    # Apply output XML replacements
    output_content = apply_replacements(output_content, get_replacements_by_category("latex_xml"))
    output_content = apply_replacements(output_content, get_replacements_by_category("scratchpad_xml"))

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

            # Extract agent name and model from the output file name
            output_parts = os.path.basename(output_file).split("_")
            agent = output_parts[-3]
            model = output_parts[-1].split(".")[0]

            # Determine the round number from the output file name
            round_match = re.search(r"_r(\d+)_", output_file)
            round = int(round_match.group(1)) if round_match else 0

            for doc in latex_documents.findall("document"):
                source = doc.get("name")
                logger.debug(f"XML Source: {source}")
                content = doc.text

                if source is not None and content is not None:
                    # Generate the output file name
                    base_name, extension = os.path.splitext(source)
                    extension = extension.strip(".")
                    tex_file = get_output_file_name(base_name, agent, model, extension, round=round)

                    content_text = content.strip()

                    # Write the content to the file
                    write_file(tex_file, content_text)
                    output_files.append(tex_file)
                    logger.debug(f"TeX file written: {tex_file}")
                else:
                    logger.error(f"Invalid document structure in {document_tag}")

            return output_files

        else:
            logger.error(f"No {document_tag} found in output file.")
            return []

    except ET.ParseError as e:
        logger.error(f"Failed to parse XML content: {str(e)}")
        return []
