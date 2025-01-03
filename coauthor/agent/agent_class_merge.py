import os
import re

from ..logger import logger

from .agent_config import AgentConfig
from .agent_dataclass import AgentSettings, AgentPrompts
from .agent_class_direct import DirectAgent
from .agent_state import AgentStateRound, AgentStateGlobal
from .model_handler import ModelHandler


class MergeAgent(DirectAgent):
    """Agent for merging multiple edited files into a single output."""

    def __init__(
        self,
        modelHandler: ModelHandler,
        agentConfig: AgentConfig,
        agentSettings: AgentSettings,
        agentPrompts: AgentPrompts,
        agentPath: str,
    ) -> None:
        """Initialize merge agent with model handler, configs, settings, prompts and path."""
        super().__init__(modelHandler, agentConfig, agentSettings, agentPrompts, agentPath)
        self.outputFile = [self.get_outputFile(r) for r in range(2)]

    def _parse_filename_parts(self, edited_base: str) -> tuple[str, str, int, str]:
        """Parse filename parts to extract base name, agent, round number and model."""
        parts = edited_base.split("_")
        underscore_count = edited_base.count("_")
        base = parts[0]

        # Extract agent name
        agent = self._extract_agentName(parts, underscore_count)
        if agent is None:
            raise ValueError(f"Could not extract agent name from edited base: {edited_base}")

        # Extract round number
        round_match = re.search(r"_r(\d+)_", edited_base)
        if not round_match:
            raise ValueError(f"Could not extract round number from edited base: {edited_base}")
        round_num = int(round_match.group(1))

        # Get model name (last part)
        model = parts[-1]

        return base, agent, round_num, model

    def get_outputFile(self, currRound: int) -> str:
        """Generate output filename for merged content."""
        inputFile = self.agentConfig.inputFile
        editedFile = self.agentConfig.editedFile

        if not editedFile:
            raise ValueError("editedFile must be specified for merge handler")

        input_dir = os.path.dirname(inputFile)
        input_base, _ = os.path.splitext(os.path.basename(inputFile))
        edited_base, _ = os.path.splitext(os.path.basename(editedFile))

        # Parse filename components
        base, agent, round_num, model = self._parse_filename_parts(edited_base)

        # Use original input base if it differs from edited base
        if input_base != base:
            base = input_base

        # Construct output filename
        outputFile = f"{base}_{agent}_r{round_num}_full_{model}.tex"
        output_path = os.path.join(input_dir, outputFile)
        logger.info(f"Merge output file: {output_path}")
        return output_path

    def _extract_agentName(self, parts: list[str], underscore_count: int) -> str | None:
        """Extract agent name from filename parts.

        Handles two formats:
        - Standard: base_agent_r1_model
        - Complex: MutualInfo_restructured_polish_r1_sonnet++
        """
        if underscore_count == 3:
            # Standard format
            return parts[1]

        # Complex format - collect parts until round number
        agent_parts = []
        for i, part in enumerate(parts[1:], 1):
            if part.startswith("r") and part[1:].isdigit():
                return "_".join(agent_parts)
            agent_parts.append(part)
        return None

    def handle_output(
        self,
        stateRound: AgentStateRound,
        stateGlobal: AgentStateGlobal,
        outputFile: str,
        endTurn: bool,
        currRound: int = 0,
    ) -> list[str]:
        """Process and handle output files for the current round."""
        if endTurn:
            _files = super().handle_output(stateRound, stateGlobal, outputFile, endTurn, currRound)
            logger.info(f"Output file: {outputFile}")
            return _files
        return []
