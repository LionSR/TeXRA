import os
import re
import xml.etree.ElementTree as ET
from typing import Any

from ..logger import logger

from ..agent import AgentConfig, AgentSettings
from ..latex import run_latexdiff, run_latexdiff_for_round, run_latexdiff_between_rounds
from ..utils.file import read_file, write_file
from ..utils.replacement import apply_replacements, get_replacements_by_category
from ..utils.xml import (
    add_cdata_to_tags,
    add_cdata_to_tags_multiple,
    filter_tags_from_text,
    extract_content_from_tag,
)

from .logdb import update_log_outputFiles


def get_outputFile_name(inputFile: str, agent: str, model: str, outputExt: str, currRound: int, editedFile: str | None = None) -> str:
    """Generate output filename based on input parameters."""
    file_name, _ = os.path.splitext(inputFile)
    agent_first_name_chunk = agent.split("_")[0]

    new_round = currRound
    if editedFile:
        match = re.search(r"_r(\d+)_", editedFile)
        edited_round = int(match.group(1)) if match else 0
        new_round += edited_round + 1

    outputFile = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{outputExt}"
    logger.debug(f"Output file: {outputFile}")
    return outputFile


class OutputHandler:
    """Handler for processing and managing output files."""

    def __init__(self, agentSettings: AgentSettings, agentConfig: AgentConfig, modelHandler: Any, logId: int):
        """Initialize output handler with settings and configuration."""
        self.agentSettings = agentSettings
        self.agentConfig = agentConfig
        self.modelHandler = modelHandler
        self.logId = logId
        self.outputFiles = {0: [], 1: []}  # Maps round number to output files
        self.base_files = []  # Original input files

    def _process_xml_content(self, outputContent: str) -> str:
        """Process XML content by applying filters and replacements."""
        outputContent = filter_tags_from_text(outputContent, "monologue")
        outputContent = apply_replacements(outputContent, get_replacements_by_category("latex_xml"))
        outputContent = apply_replacements(outputContent, get_replacements_by_category("scratchpad_xml"))
        return outputContent

    def _handle_scratchpad(self, root: ET.Element, base_name: str, thinkingTag: str, split_and_save_thinking: bool) -> None:
        """Save thinking content to separate file if enabled."""
        if split_and_save_thinking:
            logFileThinking = f"{base_name}_thinking.xml"
            logger.debug(f"Thinking file: {logFileThinking}")
            scratchpad = root.find(thinkingTag)
            if scratchpad is not None:
                scratchpadContent = ET.tostring(scratchpad, encoding="unicode", method="text")
                write_file(logFileThinking, f"<scratchpad>\n{scratchpadContent.strip()}\n</scratchpad>\n")

    def _handle_single_output(self, outputFile: str) -> None:
        """Generate LaTeX diff for single output file."""
        if ".tex" in self.agentConfig.inputFile and ".tex" in outputFile:
            _ = run_latexdiff(self.agentConfig.inputFile, outputFile)

    def _handle_multiple_outputs(self, outputFiles: list[str]) -> None:
        """Generate LaTeX diffs for multiple output files."""
        logger.debug(f"Handling multiple outputs: tasked outputFiles: {self.agentConfig.outputFiles}; actual outputFiles: {outputFiles}")
        if self.agentConfig.outputFiles:
            for inputFile, outputFile in zip(self.agentConfig.outputFiles, outputFiles):
                update_log_outputFiles(self.logId, outputFile)
                if ".tex" in inputFile and ".tex" in outputFile:
                    _ = run_latexdiff(inputFile, outputFile)

    def _process_single_output(self, outputFile: str) -> str:
        """Process single output file and return processed file path."""
        processed_outputFile = self.split_scratchpad_output_xml(outputFile, self.agentSettings.documentTag)
        content = read_file(processed_outputFile)
        filtered_content = filter_tags_from_text(content, "monologue")
        write_file(processed_outputFile, filtered_content)
        return processed_outputFile

    def _process_multiple_outputs(self, outputFile: str) -> list[str]:
        """Process file containing multiple outputs and return processed file paths."""
        processed_outputFiles = self.split_multiple_scratchpad_output_xml(outputFile, self.agentSettings.documentTag)
        for processed_outputFile in processed_outputFiles:
            content = read_file(processed_outputFile)
            filtered_content = filter_tags_from_text(content, "monologue")
            write_file(processed_outputFile, filtered_content)
        return processed_outputFiles

    def split_scratchpad_output_xml(
        self, outputFile: str, documentTag: str, thinkingTag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> str:
        """Split scratchpad output XML into separate files."""
        logger.debug(f"Splitting scratchpad output XML: {outputFile}")

        base_name, extension = os.path.splitext(outputFile)
        tex_file = f"{base_name}.tex"
        logger.debug(f"TeX file: {tex_file}")

        outputContent = read_file(outputFile)
        outputContent = self._process_xml_content(outputContent)

        tags_to_wrap = [documentTag, thinkingTag]
        outputContent = add_cdata_to_tags(outputContent, tags_to_wrap)

        rootContent = f"<root>{outputContent}</root>"

        try:
            root = ET.fromstring(rootContent)
            self._handle_scratchpad(root, base_name, thinkingTag, split_and_save_thinking)

            latex_document = extract_content_from_tag(root, documentTag)
            if latex_document:
                write_file(tex_file, latex_document)
            else:
                logger.error(f"No {documentTag} found in output file")
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")

        return tex_file

    def split_multiple_scratchpad_output_xml(
        self, outputFile: str, documentTag: str, thinkingTag: str = "scratchpad", split_and_save_thinking: bool = False
    ) -> list[str]:
        """Split multiple scratchpad output XML into separate files."""
        logger.debug(f"Splitting multiple scratchpad output XML: {outputFile}")
        base_name, extension = os.path.splitext(outputFile)

        outputContent = read_file(outputFile)
        outputContent = self._process_xml_content(outputContent)

        tags_to_wrap = [thinkingTag, "document"]
        outputContent = add_cdata_to_tags_multiple(outputContent, tags_to_wrap)

        rootContent = f"<root>{outputContent}</root>"

        try:
            root = ET.fromstring(rootContent)
            self._handle_scratchpad(root, base_name, thinkingTag, split_and_save_thinking)

            latex_documents = root.find(documentTag)
            if latex_documents:
                return self._process_latex_documents(latex_documents, outputFile)

            logger.error(f"No {documentTag} found in output file.")
            return []
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")
            return []

    def _process_latex_documents(self, latex_documents: ET.Element, outputFile: str) -> list[str]:
        """Process LaTeX documents and return processed file paths."""
        outputFiles = []
        output_parts = os.path.basename(outputFile).split("_")
        agent = output_parts[-3]
        model = output_parts[-1].split(".")[0]

        round_match = re.search(r"_r(\d+)_", outputFile)
        currRound = int(round_match.group(1)) if round_match else 0

        for doc in latex_documents.findall("document"):
            source = doc.get("name")
            logger.debug(f"XML Source: {source}")
            content = doc.text

            if source is not None and content is not None:
                base_name, extension = os.path.splitext(source)
                extension = extension.strip(".")
                tex_file = get_outputFile_name(base_name, agent, model, extension, currRound=currRound)
                write_file(tex_file, content.strip())
                outputFiles.append(tex_file)
                logger.debug(f"TeX file written: {tex_file}")
            else:
                logger.error(f"Invalid document structure in {latex_documents.tag}")

        return outputFiles

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

    def _handle_latexdiff(self, currRound: int) -> None:
        """Handle LaTeX diff generation between files and rounds."""
        logger.info(f"Running latexdiff for {self.agentConfig.agent} round {currRound}")
        logger.debug(f"Base files: {self.base_files}")
        logger.debug(f"Round {currRound} output files: {self.outputFiles[currRound]}")

        # Generate diffs between base files and current round
        for base_file, outputFile in zip(self.base_files, self.outputFiles[currRound]):
            run_latexdiff_for_round(base_file, outputFile, currRound)

        # Generate diffs between consecutive rounds
        for r in range(1, currRound + 1):
            for outputFile1, outputFile2 in zip(self.outputFiles[r - 1], self.outputFiles[r]):
                run_latexdiff_between_rounds(outputFile1, outputFile2)

    def _replace_input_commands(self, base_files: list[str], outputFiles: list[str]) -> None:
        """Replace LaTeX input commands with updated file names."""
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(base_files, outputFiles)}

        for outputFile in outputFiles:
            content = read_file(outputFile)
            new_content = re.sub(
                r"\\input{([^}]+)}",
                lambda match: (f"\\input{{{base_to_output[match.group(1)]}}}" if match.group(1) in base_to_output else match.group(0)),
                content,
            )

            if new_content != content:
                write_file(outputFile, new_content)
                logger.debug(f"Updated input commands in {outputFile}")
