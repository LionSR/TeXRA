import os
import re

from ..logger import logger

from .agent_config import AgentConfig
from .agent_dataclass import AgentSetting, AgentPrompt
from .DirectAgent import DirectAgent
from .agent_state import AgentStateRound, AgentStateGlobal
from .model_handler import ModelHandler


class MergeAgent(DirectAgent):
    """Agent for merging multiple edited files into a single output."""

    def __init__(
        self,
        modelHandler: ModelHandler,
        agentConfig: AgentConfig,
        agentSetting: AgentSetting,
        agentPrompt: AgentPrompt,
        agentPath: str,
    ) -> None:
        """Initialize merge agent with model handler, configs, settings, prompts and path."""
        super().__init__(modelHandler, agentConfig, agentSetting, agentPrompt, agentPath)
        self.outputFile = [self.getOutputFile(r) for r in range(2)]

    def _parseFilenameParts(self, editedBase: str) -> tuple[str, str, int, str]:
        """Parse filename parts to extract base name, agent, round number and model."""
        parts = editedBase.split("_")
        underscoreCount = editedBase.count("_")
        base = parts[0]

        # Extract agent name
        agent = self._extractAgentName(parts, underscoreCount)
        if agent is None:
            raise ValueError(f"Could not extract agent name from edited base: {editedBase}")

        # Extract round number
        roundMatch = re.search(r"_r(\d+)_", editedBase)
        if not roundMatch:
            raise ValueError(f"Could not extract round number from edited base: {editedBase}")
        roundNum = int(roundMatch.group(1))

        # Get model name (last part)
        model = parts[-1]

        return base, agent, roundNum, model

    def getOutputFile(self, currRound: int) -> str:
        """Generate output filename for merged content."""
        inputFile = self.agentConfig.inputFile
        editedFile = self.agentConfig.editedFile

        if not editedFile:
            raise ValueError("editedFile must be specified for merge handler")

        inputDir = os.path.dirname(inputFile)
        inputBase, _ = os.path.splitext(os.path.basename(inputFile))
        editedBase, _ = os.path.splitext(os.path.basename(editedFile))

        # Parse filename components
        base, agent, roundNum, model = self._parseFilenameParts(editedBase)

        # Use original input base if it differs from edited base
        if inputBase != base:
            base = inputBase

        # Construct output filename
        outputFile = f"{base}_{agent}_r{roundNum}_full_{model}.tex"
        output_path = os.path.join(inputDir, outputFile)
        logger.info(f"Merge output file: {output_path}")
        return output_path

    def _extractAgentName(self, parts: list[str], underscoreCount: int) -> str | None:
        """Extract agent name from filename parts.

        Handles two formats:
        - Standard: base_agent_r1_model
        - Complex: MutualInfo_restructured_polish_r1_sonnet++
        """
        if underscoreCount == 3:
            # Standard format
            return parts[1]

        # Complex format - collect parts until round number
        agent_parts = []
        for i, part in enumerate(parts[1:], 1):
            if part.startswith("r") and part[1:].isdigit():
                return "_".join(agent_parts)
            agent_parts.append(part)
        return None

    def handleOutput(
        self,
        stateRound: AgentStateRound,
        stateGlobal: AgentStateGlobal,
        outputFile: str,
        endTurn: bool,
        currRound: int = 0,
    ) -> list[str]:
        """Process and handle output files for the current round."""
        if endTurn:
            _files = super().handleOutput(stateRound, stateGlobal, outputFile, endTurn, currRound)
            logger.info(f"Output file: {outputFile}")
            return _files
        return []
