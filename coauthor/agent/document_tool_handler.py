"""Handler for document analysis and figure extraction tools."""

import os
from dataclasses import dataclass

from ..latex import (
    extract_and_compile_tikzpictures_with_labels,
    extract_figure_paths_from_latex,
    get_tex_count_stats,
)
from ..utils.prompt import get_first_k_from_document
from ..logger import logger
from .tool_handler import ToolState
from .agent_dataclass import AgentConfig


@dataclass
class ToolConfiguration:
    """Configuration for document processing tools."""

    include_tex_count: bool = False
    use_prefill_from_input: bool = False
    auto_extract_figure: bool = False
    auto_extract_tikz_figure: bool = False
    auto_extract_tikz_figure_reflect: bool = False

    @classmethod
    def from_agent_config(cls, agent_config: AgentConfig) -> "ToolConfiguration":
        """Create tool configuration from agent config."""
        return cls(
            include_tex_count=agent_config.include_tex_count,
            use_prefill_from_input=agent_config.use_prefill_from_input,
            auto_extract_figure=agent_config.auto_extract_figure,
            auto_extract_tikz_figure=agent_config.auto_extract_tikz_figure,
            auto_extract_tikz_figure_reflect=agent_config.auto_extract_tikz_figure_reflect,
        )


class DocumentToolHandler:
    """Handler for document analysis and figure extraction tools."""

    def __init__(self, tool_state: ToolState, tool_config: ToolConfiguration):
        """Initialize document tool handler with tool state and configuration.

        Args:
            tool_state: State object for tracking tool operations
            tool_config: Configuration for tool behavior
        """
        self.tool_state = tool_state
        self.tool_config = tool_config
        self._validate_configuration()

    def _validate_configuration(self) -> None:
        """Validate tool configuration."""
        if not isinstance(self.tool_config, ToolConfiguration):
            raise ValueError("Invalid tool configuration type")

    def _validate_input_files(self, input_files: str | list[str]) -> list[str]:
        """Validate and normalize input files.

        Args:
            input_files: Single file path or list of file paths

        Returns:
            List of validated file paths

        Raises:
            ValueError: If any input file is invalid
        """
        if isinstance(input_files, str):
            input_files = [input_files]

        for file_path in input_files:
            if not os.path.exists(file_path):
                raise ValueError(f"Input file does not exist: {file_path}")
            if not os.path.isfile(file_path):
                raise ValueError(f"Input path is not a file: {file_path}")

        return input_files

    def process_document_statistics(self, input_files: str | list[str]) -> None:
        """Process and store document statistics using texcount.

        Args:
            input_files: Single file path or list of file paths to analyze

        Raises:
            ValueError: If input files are invalid
        """
        if not self.tool_config.include_tex_count:
            logger.debug("Skipping tex count - not enabled in configuration")
            return

        try:
            validated_files = self._validate_input_files(input_files)
            if stats := get_tex_count_stats(validated_files):
                self.tool_state.tex_count_stats = stats
                logger.info(f"Generated tex count statistics for {validated_files}")
            else:
                logger.warning(f"Failed to generate tex count statistics for {validated_files}")
        except Exception as e:
            logger.error(f"Error processing document statistics: {str(e)}")
            raise

    def process_document_prefill(self, input_file: str, k: int) -> None:
        """Extract and store first K lines from document for prefill.

        Args:
            input_file: Path to input file
            k: Number of lines to extract

        Raises:
            ValueError: If input file is invalid or k is not positive
        """
        if not self.tool_config.use_prefill_from_input:
            logger.debug("Skipping prefill extraction - not enabled in configuration")
            return

        try:
            if k <= 0:
                raise ValueError("k must be positive")

            validated_files = self._validate_input_files(input_file)
            if prefill := get_first_k_from_document(validated_files[0], k):
                self.tool_state.first_k_tex_document = prefill
                logger.info(f"Extracted first {k} lines from {input_file}")
            else:
                logger.warning(f"Failed to extract first {k} lines from {input_file}")
        except Exception as e:
            logger.error(f"Error processing document prefill: {str(e)}")
            raise

    def process_latex_figures(self, input_file: str) -> None:
        """Extract and store figure paths from LaTeX document.

        Args:
            input_file: Path to LaTeX file to analyze

        Raises:
            ValueError: If input file is invalid
        """
        if not self.tool_config.auto_extract_figure:
            logger.debug("Skipping figure extraction - not enabled in configuration")
            return

        try:
            validated_files = self._validate_input_files(input_file)
            if figure_paths := extract_figure_paths_from_latex(validated_files[0]):
                self.tool_state.add_figure_files(figure_paths)
                logger.info(f"Extracted {len(figure_paths)} figure paths from {input_file}")
            else:
                logger.warning(f"No figure paths found in {input_file}")
        except Exception as e:
            logger.error(f"Error processing LaTeX figures: {str(e)}")
            raise

    def process_tikz_figures(self, input_files: str | list[str], is_reflection: bool = False) -> None:
        """Extract, compile and store TikZ figures from LaTeX document(s).

        Args:
            input_files: Single file path or list of file paths to process
            is_reflection: Whether this is being called during reflection phase

        Raises:
            ValueError: If input files are invalid
        """
        if not (self.tool_config.auto_extract_tikz_figure or (is_reflection and self.tool_config.auto_extract_tikz_figure_reflect)):
            logger.debug("Skipping TikZ figure extraction - not enabled in configuration")
            return

        try:
            validated_files = self._validate_input_files(input_files)
            for input_file in validated_files:
                if compiled_files := extract_and_compile_tikzpictures_with_labels(input_file):
                    self.tool_state.add_figure_files(compiled_files)
                    logger.info(
                        f"Extracted and compiled {len(compiled_files)} TikZ figures from {input_file}"
                        + (" (reflection phase)" if is_reflection else "")
                    )
                else:
                    logger.warning(f"No TikZ figures found in {input_file}")
        except Exception as e:
            logger.error(f"Error processing TikZ figures: {str(e)}")
            raise

    def process_all_tools(self, input_files: str | list[str], k: int = 200, is_reflection: bool = False) -> None:
        """Process all enabled document tools in the correct order.

        Args:
            input_files: Single file path or list of file paths to process
            k: Number of lines for prefill extraction
            is_reflection: Whether this is being called during reflection phase

        Raises:
            Exception: If any tool processing fails
        """
        try:
            validated_files = self._validate_input_files(input_files)

            # Process tools in order of dependencies
            if self.tool_config.include_tex_count:
                self.process_document_statistics(validated_files)

            if self.tool_config.use_prefill_from_input:
                self.process_document_prefill(validated_files[0], k)

            if self.tool_config.auto_extract_figure:
                for input_file in validated_files:
                    self.process_latex_figures(input_file)

            if self.tool_config.auto_extract_tikz_figure or (is_reflection and self.tool_config.auto_extract_tikz_figure_reflect):
                self.process_tikz_figures(validated_files, is_reflection)

        except Exception as e:
            logger.error(f"Error processing document tools: {str(e)}")
            raise
