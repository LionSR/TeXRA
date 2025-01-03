import os
import re
import xml.etree.ElementTree as ET
from typing import Any

from ..logger import logger

from ..agent import AgentConfig, AgentSettings
from ..latex import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds
from ..utils.file import read_file, write_file
from ..utils.replacement import apply_replacements, get_replacements_by_category
from ..utils.xml import add_cdata_to_tags, add_cdata_to_tags_multiple, filter_tags_from_text

from .logdb import update_log_output_files


def get_output_file_name(input_file: str, agent: str, model: str, outputExt: str, curr_round: int, edited_file: str | None = None) -> str:
    """Generate output filename based on input parameters."""
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]

    new_round = curr_round
    if edited_file:
        match = re.search(r"_r(\d+)_", edited_file)
        edited_round = int(match.group(1)) if match else 0
        new_round += edited_round + 1

    output_file = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{outputExt}"
    logger.debug(f"Output file: {output_file}")
    return output_file


class OutputHandler:
    """Handler for processing and managing output files."""

    def __init__(self, agent_settings: AgentSettings, agent_config: AgentConfig, model_handler: Any, log_id: int):
        """Initialize output handler with settings and configuration."""
        self.agent_settings = agent_settings
        self.agent_config = agent_config
        self.model_handler = model_handler
        self.log_id = log_id
        self.output_files = {0: [], 1: []}  # Maps round number to output files
        self.base_files = []  # Original input files

    def _process_xml_content(self, output_content: str) -> str:
        """Process XML content by applying filters and replacements."""
        output_content = filter_tags_from_text(output_content, "monologue")
        output_content = apply_replacements(output_content, get_replacements_by_category("latex_xml"))
        output_content = apply_replacements(output_content, get_replacements_by_category("scratchpad_xml"))
        return output_content

    def _extract_document_content(self, root: ET.Element, documentTag: str) -> str | None:
        """Extract content from XML document element."""
        latex_document = root.find(documentTag)
        if latex_document is not None:
            return ET.tostring(latex_document, encoding="unicode", method="text").strip()
        logger.error(f"No {documentTag} found in output file")
        return None

    def _handle_scratchpad(self, root: ET.Element, base_name: str, thinking_tag: str, split_and_save_thinking: bool) -> None:
        """Save thinking content to separate file if enabled."""
        if split_and_save_thinking:
            log_file_thinking = f"{base_name}_thinking.xml"
            logger.debug(f"Thinking file: {log_file_thinking}")
            scratchpad = root.find(thinking_tag)
            if scratchpad is not None:
                scratchpad_content = ET.tostring(scratchpad, encoding="unicode", method="text")
                write_file(log_file_thinking, f"<scratchpad>\n{scratchpad_content.strip()}\n</scratchpad>\n")

    def _handle_single_output(self, output_file: str) -> None:
        """Generate LaTeX diff for single output file."""
        if ".tex" in self.agent_config.input_file and ".tex" in output_file:
            _ = run_latexdiff(self.agent_config.input_file, output_file)

    def _handle_multiple_outputs(self, output_files: list[str]) -> None:
        """Generate LaTeX diffs for multiple output files."""
        logger.debug(f"Handling multiple outputs: tasked output_files: {self.agent_config.output_files}; actual output_files: {output_files}")
        if self.agent_config.output_files:
            for input_file, output_file in zip(self.agent_config.output_files, output_files):
                update_log_output_files(self.log_id, output_file)
                if ".tex" in input_file and ".tex" in output_file:
                    _ = run_latexdiff(input_file, output_file)

    def _process_single_output(self, output_file: str) -> str:
        """Process single output file and return processed file path."""
        processed_output_file = self.split_scratchpad_output_xml(output_file, self.agent_settings.documentTag)
        content = read_file(processed_output_file)
        filtered_content = filter_tags_from_text(content, "monologue")
        write_file(processed_output_file, filtered_content)
        return processed_output_file

    def _process_multiple_outputs(self, output_file: str) -> list[str]:
        """Process file containing multiple outputs and return processed file paths."""
        processed_output_files = self.split_multiple_scratchpad_output_xml(output_file, self.agent_settings.documentTag)
        for processed_output_file in processed_output_files:
            content = read_file(processed_output_file)
            filtered_content = filter_tags_from_text(content, "monologue")
            write_file(processed_output_file, filtered_content)
        return processed_output_files

    def split_scratchpad_output_xml(
        self, output_file: str, documentTag: str, thinking_tag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> str:
        """Split scratchpad output XML into separate files."""
        logger.debug(f"Splitting scratchpad output XML: {output_file}")

        base_name, extension = os.path.splitext(output_file)
        tex_file = f"{base_name}.tex"
        logger.debug(f"TeX file: {tex_file}")

        output_content = read_file(output_file)
        output_content = self._process_xml_content(output_content)

        tags_to_wrap = [documentTag, thinking_tag]
        output_content = add_cdata_to_tags(output_content, tags_to_wrap)

        root_content = f"<root>{output_content}</root>"

        try:
            root = ET.fromstring(root_content)
            self._handle_scratchpad(root, base_name, thinking_tag, split_and_save_thinking)

            latex_document = self._extract_document_content(root, documentTag)
            if latex_document:
                write_file(tex_file, latex_document)
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")

        return tex_file

    def split_multiple_scratchpad_output_xml(
        self, output_file: str, documentTag: str, thinking_tag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> list[str]:
        """Split multiple scratchpad output XML into separate files."""
        logger.debug(f"Splitting multiple scratchpad output XML: {output_file}")
        base_name, extension = os.path.splitext(output_file)

        output_content = read_file(output_file)
        output_content = self._process_xml_content(output_content)

        tags_to_wrap = [thinking_tag, "document"]
        output_content = add_cdata_to_tags_multiple(output_content, tags_to_wrap)

        root_content = f"<root>{output_content}</root>"

        try:
            root = ET.fromstring(root_content)
            self._handle_scratchpad(root, base_name, thinking_tag, split_and_save_thinking)

            latex_documents = root.find(documentTag)
            if latex_documents is not None:
                return self._process_latex_documents(latex_documents, output_file)

            logger.error(f"No {documentTag} found in output file.")
            return []
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")
            return []

    def _process_latex_documents(self, latex_documents: ET.Element, output_file: str) -> list[str]:
        """Process LaTeX documents and return processed file paths."""
        output_files = []
        output_parts = os.path.basename(output_file).split("_")
        agent = output_parts[-3]
        model = output_parts[-1].split(".")[0]

        round_match = re.search(r"_r(\d+)_", output_file)
        curr_round = int(round_match.group(1)) if round_match else 0

        for doc in latex_documents.findall("document"):
            source = doc.get("name")
            logger.debug(f"XML Source: {source}")
            content = doc.text

            if source is not None and content is not None:
                base_name, extension = os.path.splitext(source)
                extension = extension.strip(".")
                tex_file = get_output_file_name(base_name, agent, model, extension, curr_round=curr_round)
                write_file(tex_file, content.strip())
                output_files.append(tex_file)
                logger.debug(f"TeX file written: {tex_file}")
            else:
                logger.error(f"Invalid document structure in {latex_documents.tag}")

        return output_files

    def ensure_correct_xml_structure(self, file_path: str, documentTag: str) -> None:
        """Ensure correct XML structure in file."""
        logger.debug(f"Ensuring correct XML structure: {file_path}")
        content = read_file(file_path)
        if content.startswith("<scratchpad>") or content.startswith("<rebuttal_package>"):
            if not content.endswith(f"</{documentTag}>"):
                if "</{documentTag}>" not in content and f"<{documentTag}>" in content:
                    content += f"\n</{documentTag}>"
                else:
                    content = re.sub(f"</{documentTag}>.*$", "", content, flags=re.DOTALL)
                    if f"<{documentTag}>" in content:
                        content += f"\n<{documentTag}>"

            content = self._process_xml_content(content)

        write_file(file_path, content)

    def _handle_latexdiff(self, curr_round: int) -> None:
        """Handle LaTeX diff generation between files and rounds."""
        logger.info(f"Running latexdiff for {self.agent_config.agent} round {curr_round}")
        logger.debug(f"Base files: {self.base_files}")
        logger.debug(f"Round {curr_round} output files: {self.output_files[curr_round]}")

        # Generate diffs between base files and current round
        for base_file, output_file in zip(self.base_files, self.output_files[curr_round]):
            run_latexdiff_for_round(base_file, output_file, curr_round)

        # Generate diffs between consecutive rounds
        for r in range(1, curr_round + 1):
            for output_file1, output_file2 in zip(self.output_files[r - 1], self.output_files[r]):
                run_latexdiff_between_rounds(output_file1, output_file2)

    def _replace_input_commands(self, base_files: list[str], output_files: list[str]) -> None:
        """Replace LaTeX input commands with updated file names."""
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(base_files, output_files)}

        for output_file in output_files:
            content = read_file(output_file)
            new_content = re.sub(
                r"\\input{([^}]+)}",
                lambda match: (f"\\input{{{base_to_output[match.group(1)]}}}" if match.group(1) in base_to_output else match.group(0)),
                content,
            )

            if new_content != content:
                write_file(output_file, new_content)
                logger.debug(f"Updated input commands in {output_file}")
