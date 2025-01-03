from .agent_base import BaseReflectionAgent
from .agent_state import AgentStateRound, AgentStateGlobal
from .output_handler import get_outputFile_name


class CoTAgent(BaseReflectionAgent):
    def get_outputFile(self, currRound: int) -> str:
        """Get the output file name for the given round."""
        base_outputFile = self.agentConfig.outputNameOverride or self.agentConfig.inputFile
        file_extension = "xml" if self.use_scratchpad else self.agentSettings.outputExt
        return get_outputFile_name(
            base_outputFile, self.agentConfig.agent, self.modelHandler.config.name, file_extension, currRound, self.agentConfig.editedFile
        )

    def handle_output(
        self,
        stateRound: AgentStateRound,  # Current round state object
        stateGlobal: AgentStateGlobal,  # Global state object
        outputFile: str,  # Path to output file
        endTurn: bool,  # Flag indicating end of turn
        currRound: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if endTurn:
            self.output_handler.ensure_correct_xml_structure(outputFile, self.agentSettings.documentTag)
            self._process_outputFiles(outputFile, currRound)

        # Call base implementation for database updates
        return super().handle_output(stateRound, stateGlobal, outputFile, endTurn, currRound)
