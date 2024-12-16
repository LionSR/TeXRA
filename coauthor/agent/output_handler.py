import os
import re


import xml.etree.ElementTree as ET
from typing import Optional, List, Any

from ..logger import logger
from ..agent import AgentConfig, AgentSettings
from ..latex import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds

from ..utils.file import read_file, write_file
from ..utils.replacement import apply_replacements, get_replacements_by_category
from ..utils.xml import add_cdata_to_tags, add_cdata_to_tags_multiple, filter_tags_from_text

from .logdb import logdb_output_files


def get_output_file_name(input_file: str, agent: str, model: str, output_ext: str, round: int, edited_file: str | None = None) -> str:
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]

    new_round = round
    # this is for continuing from an edited file and adding a new round
    if edited_file:
        match = re.search(r"_r(\d+)_", edited_file)
        edited_round = int(match.group(1)) if match else 0
        new_round += edited_round + 1

    output_file = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{output_ext}"
    logger.debug(f"Output file: {output_file}")
    return output_file


class OutputHandler:
    """Base class for handling agent outputs."""

    def __init__(self, agent_settings: AgentSettings, agent_config: AgentConfig, model_config: Any, log_id: int):
        self.agent_settings = agent_settings
        self.agent_config = agent_config
        self.model_config = model_config
        self.log_id = log_id
        self.output_files = {0: [], 1: []}
        self.base_files = []

    def _handle_single_output(self, output_file: str) -> None:
        if ".tex" in self.agent_config.input_file and ".tex" in output_file:
            _ = run_latexdiff(self.agent_config.input_file, output_file, self.agent_config.agent)

    def _handle_multiple_outputs(self, output_files: list[str]) -> None:
        logger.debug(f"Handling multiple outputs: tasked output_files: {self.agent_config.output_files}; actual output_files: {output_files}")
        if self.agent_config.output_files:
            for input_file, output_file in zip(self.agent_config.output_files, output_files):
                logdb_output_files(output_file, self.log_id)
                if ".tex" in input_file and ".tex" in output_file:
                    _ = run_latexdiff(input_file, output_file, self.agent_config.agent)

    def _process_single_output(self, output_file: str) -> str:
        """Process a single output file."""
        processed_output_file = self.split_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
        content = read_file(processed_output_file)
        filtered_content = filter_tags_from_text(content, "monologue")
        write_file(processed_output_file, filtered_content)
        return processed_output_file

    def _process_multiple_outputs(self, output_file: str) -> list[str]:
        """Process multiple output files."""
        processed_output_files = self.split_multiple_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
        for processed_output_file in processed_output_files:
            content = read_file(processed_output_file)
            filtered_content = filter_tags_from_text(content, "monologue")
            write_file(processed_output_file, filtered_content)
        return processed_output_files

    def _handle_latexdiff(self, round: int) -> None:
        logger.info(f"Running latexdiff for {self.agent_config.agent} round {round}")

        logger.debug(f"Base files: {self.base_files}")
        logger.debug(f"Round {round} output files: {self.output_files[round]}")

        for base_file, output_file in zip(self.base_files, self.output_files[round]):
            run_latexdiff_for_round(base_file, output_file, self.agent_config.agent, round)

        for r in range(1, round + 1):
            for output_file1, output_file2 in zip(self.output_files[r - 1], self.output_files[r]):
                run_latexdiff_between_rounds(output_file1, output_file2, self.agent_config.agent)

    def _replace_input_commands(self, base_files: list[str], output_files: list[str]) -> None:
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(base_files, output_files)}

        for output_file in output_files:
            content = read_file(output_file)

            def replace_input(match):
                input_file = match.group(1)
                if input_file in base_to_output:
                    return f"\\input{{{base_to_output[input_file]}}}"
                return match.group(0)

            new_content = re.sub(r"\\input{([^}]+)}", replace_input, content)

            if new_content != content:
                write_file(output_file, new_content)
                logger.debug(f"Updated input commands in {output_file}")

    # the following two functions can reuse some components
    def split_scratchpad_output_xml(
        self, output_file: str, document_tag: str, thinking_tag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> str:
        logger.debug(f"Splitting scratchpad output XML: {output_file}")

        # hoepfully this has been handled by output_files_default?
        # if document_tag in ["latex_documents", "rebuttal_package"]:
        #     return split_multiple_scratchpad_output_xml(output_file, document_tag, thinking_tag, split_and_save_thinking)

        base_name, extension = os.path.splitext(output_file)
        tex_file = f"{base_name}.tex"
        logger.debug(f"TeX file: {tex_file}")

        # Read the content of the output file
        output_content = read_file(output_file)

        # Filter monologue tags first (if model likes to ask confirmation?)
        output_content = filter_tags_from_text(output_content, "monologue")

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
                log_file_thinking = f"{base_name}_thinking.xml"
                logger.debug(f"Thinking file: {log_file_thinking}")
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

    def split_multiple_scratchpad_output_xml(
        self, output_file: str, document_tag: str, thinking_tag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> list[str]:
        logger.debug(f"Splitting multiple scratchpad output XML: {output_file}")

        base_name, extension = os.path.splitext(output_file)

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
                log_file_thinking = f"{base_name}_thinking.xml"
                logger.debug(f"Log file: {log_file_thinking}")
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

    def ensure_correct_xml_structure(self, file_path: str, document_tag: str) -> None:
        logger.debug(f"Ensuring correct XML structure: {file_path}")
        content = read_file(file_path)
        if content.startswith("<scratchpad>") or content.startswith("<rebuttal_package>"):
            if not content.endswith(f"</{document_tag}>"):
                if "</{document_tag}>" not in content and f"<{document_tag}>" in content:
                    content += f"\n</{document_tag}>"
                else:
                    # Move the closing tag to the end
                    content = re.sub(f"</{document_tag}>.*$", "", content, flags=re.DOTALL)
                    content += f"\n</{document_tag}>"

            # Apply replacements from centralized utilities
            content = apply_replacements(content, get_replacements_by_category("latex_xml"))
            content = apply_replacements(content, get_replacements_by_category("scratchpad_xml"))

        write_file(file_path, content)


# this and the next function needs to have a better mechanism for giving the post-fix tho the names of the multiple outputs
# can we do it with regex? xml is tedious to parse
