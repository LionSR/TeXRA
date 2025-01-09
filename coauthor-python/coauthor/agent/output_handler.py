import os
import re
import xml.etree.ElementTree as ET
from typing import Any

from ..logger import logger

from ..latex import runLatexdiff, runLatexdiffForRound, runLatexdiffBetweenRounds

from ..utils.file import readFile, writeFile
from ..utils.replacement import applyReplacements, getReplacementsByCategory
from ..utils.xml import (
    addCdataToTags,
    addCdataToTagsMultiple,
    filterTagsFromText,
    extractContentFromTag,
    extractTextFromTag,
)

from .agent_dataclass import AgentSetting
from .agent_config import AgentConfig

from .logdb import update_log_outputFiles


def getOutputFileName(inputFile: str, agent: str, model: str, outputExt: str, currRound: int, editedFile: str | None = None) -> str:
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

    def __init__(self, agentSetting: AgentSetting, agentConfig: AgentConfig, modelHandler: Any, logId: int, baseFiles: list[str] | None = None):
        """Initialize output handler with settings and configuration."""
        self.agentSetting = agentSetting
        self.agentConfig = agentConfig
        self.modelHandler = modelHandler
        self.logId = logId
        self.outputFiles = {0: [], 1: []}  # Maps round number to output files
        self.baseFiles = baseFiles if baseFiles is not None else []  # Original input files

    def _processXmlContent(self, content: str) -> str:
        """Process XML content by applying filters and replacements."""
        if self.agentConfig.toolConfig.autoConfirmation:
            content = filterTagsFromText(content, "monologue")
        content = applyReplacements(content, getReplacementsByCategory("latex_xml"))
        content = applyReplacements(content, getReplacementsByCategory("scratchpad_xml"))
        return content

    def _handleSingleOutput(self, outputFile: str) -> None:
        """Generate LaTeX diff for single output file."""
        if ".tex" in self.agentConfig.inputFile and ".tex" in outputFile:
            _ = runLatexdiff(self.agentConfig.inputFile, outputFile)

    def _handleMultipleOutputs(self, outputFiles: list[str]) -> None:
        """Generate LaTeX diffs for multiple output files."""
        logger.debug(f"Handling multiple outputs: tasked outputFiles: {self.agentConfig.outputFiles}; actual outputFiles: {outputFiles}")

        if self.agentConfig.outputFiles:
            for inputFile, outputFile in zip(self.agentConfig.outputFiles, outputFiles):
                update_log_outputFiles(self.logId, outputFile)
                if ".tex" in inputFile and ".tex" in outputFile:
                    _ = runLatexdiff(inputFile, outputFile)

    def _processSingleXmlOutput(self, outputFile: str) -> str:
        """Process single output file and return processed file path."""
        processedOutputFile = self.splitScratchpadOutputXml(outputFile, self.agentSetting.documentTag)

        content = readFile(processedOutputFile)
        if self.agentConfig.toolConfig.autoConfirmation:
            filteredContent = filterTagsFromText(content, "monologue")
            writeFile(processedOutputFile, filteredContent)

        return processedOutputFile

    def _processMultipleXmlOutputs(self, outputFile: str) -> list[str]:
        """Process file containing multiple outputs and return processed file paths."""
        processedOutputFiles = self.splitScratchpadMultipleOutputXml(outputFile, self.agentSetting.documentTag)

        if self.agentConfig.toolConfig.autoConfirmation:
            for processedOutputFile in processedOutputFiles:
                content = readFile(processedOutputFile)
                filteredContent = filterTagsFromText(content, "monologue")
                writeFile(processedOutputFile, filteredContent)

        return processedOutputFiles

    def _extractAndLogScratchpad(self, outputContent: str, thinkingTag: str = "scratchpad") -> None:
        """Extract and log scratchpad content using regex."""
        scratchpadContent = extractTextFromTag(outputContent, thinkingTag)
        if scratchpadContent:
            logger.info(f"Scratchpad content:\n{scratchpadContent.strip()}")

    def splitScratchpadOutputXml(self, outputFile: str, documentTag: str, thinkingTag: str = "scratchpad") -> str:
        """Split scratchpad output XML into separate files."""
        logger.debug(f"Splitting scratchpad output XML: {outputFile}")

        baseName, extension = os.path.splitext(outputFile)
        latexFile = f"{baseName}.tex"
        logger.debug(f"LaTeX file: {latexFile}")

        outputContent = readFile(outputFile)
        outputContent = self._processXmlContent(outputContent)

        self._extractAndLogScratchpad(outputContent, thinkingTag)

        tagsToWrap = [documentTag, thinkingTag]
        outputContent = addCdataToTags(outputContent, tagsToWrap)

        rootContent = f"<root>{outputContent}</root>"

        try:
            root = ET.fromstring(rootContent)
            latex_document = extractContentFromTag(root, documentTag)
            if latex_document:
                writeFile(latexFile, latex_document)
            else:
                logger.error(f"No {documentTag} found in output file")
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")

        return latexFile

    def splitScratchpadMultipleOutputXml(self, outputFile: str, documentTag: str, thinkingTag: str = "scratchpad") -> list[str]:
        """Split multiple scratchpad output XML into separate files."""
        logger.debug(f"Splitting multiple scratchpad output XML: {outputFile}")
        baseName, extension = os.path.splitext(outputFile)

        outputContent = readFile(outputFile)
        outputContent = self._processXmlContent(outputContent)

        self._extractAndLogScratchpad(outputContent, thinkingTag)

        tagsToWrap = [thinkingTag, "document"]
        outputContent = addCdataToTagsMultiple(outputContent, tagsToWrap)

        rootContent = f"<root>{outputContent}</root>"

        try:
            root = ET.fromstring(rootContent)
            latex_documents = root.find(documentTag)
            if latex_documents:
                return self._processMultipleLatexDocuments(latex_documents, outputFile)

            logger.error(f"No {documentTag} found in output file.")
            return []
        except ET.ParseError as e:
            logger.error(f"Failed to parse XML content: {str(e)}")
            return []

    def _processMultipleLatexDocuments(self, latex_documents: ET.Element, outputFile: str) -> list[str]:
        """Process LaTeX documents and return processed file paths."""
        outputFiles = []
        output_parts = os.path.basename(outputFile).split("_")
        agent = output_parts[-3]
        model = output_parts[-1].split(".")[0]

        roundMatch = re.search(r"_r(\d+)_", outputFile)
        currRound = int(roundMatch.group(1)) if roundMatch else 0

        for doc in latex_documents.findall("document"):
            source = doc.get("name")
            logger.debug(f"XML Source: {source}")
            content = doc.text

            if source is not None and content is not None:
                baseName, extension = os.path.splitext(source)
                extension = extension.strip(".")
                tex_file = getOutputFileName(baseName, agent, model, extension, currRound=currRound)
                writeFile(tex_file, content.strip())
                outputFiles.append(tex_file)
                logger.debug(f"TeX file written: {tex_file}")
            else:
                logger.error(f"Invalid document structure in {latex_documents.tag}")

        return outputFiles

    def ensureCorrectXmlStructure(self, filePath: str, documentTag: str) -> None:
        """Ensure correct XML structure in file."""
        logger.debug(f"Ensuring correct XML structure: {filePath}")
        content = readFile(filePath)
        if content.startswith("<scratchpad>") or content.startswith("<rebuttal_package>"):
            if not content.endswith(f"</{documentTag}>"):
                if "</{documentTag}>" not in content and f"<{documentTag}>" in content:
                    content += f"\n</{documentTag}>"
                else:
                    content = re.sub(f"</{documentTag}>.*$", "", content, flags=re.DOTALL)
                    if f"<{documentTag}>" in content:
                        content += f"\n<{documentTag}>"

            content = self._processXmlContent(content)

        writeFile(filePath, content)

    def _handleLatexdiff(self, currRound: int) -> None:
        """Handle LaTeX diff generation between files and rounds."""
        logger.info(f"Running latexdiff for {self.agentConfig.agent} round {currRound}")
        logger.debug(f"Base files: {self.baseFiles}")
        logger.debug(f"Round {currRound} output files: {self.outputFiles[currRound]}")

        # Generate diffs between base files and current round
        for baseFile, outputFile in zip(self.baseFiles, self.outputFiles[currRound]):
            runLatexdiffForRound(baseFile, outputFile, currRound)

        # Generate diffs between consecutive rounds
        for r in range(1, currRound + 1):
            for outputFile1, outputFile2 in zip(self.outputFiles[r - 1], self.outputFiles[r]):
                runLatexdiffBetweenRounds(outputFile1, outputFile2)

    def _replaceInputCommands(self, baseFiles: list[str], outputFiles: list[str]) -> None:
        """Replace LaTeX input commands with updated file names."""
        base_to_output = {os.path.basename(bf): os.path.basename(of) for bf, of in zip(baseFiles, outputFiles)}

        for outputFile in outputFiles:
            content = readFile(outputFile)
            Newcontent = re.sub(
                r"\\input{([^}]+)}",
                lambda match: (f"\\input{{{base_to_output[match.group(1)]}}}" if match.group(1) in base_to_output else match.group(0)),
                content,
            )

            if Newcontent != content:
                writeFile(outputFile, Newcontent)
                logger.debug(f"Updated input commands in {outputFile}")
