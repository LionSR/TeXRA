from .BaseReflectionAgent import BaseReflectionAgent
from .agent_state import AgentStateRound, AgentStateGlobal
from .output_handler import getOutputFileName


class DirectAgent(BaseReflectionAgent):
    def getOutputFile(self, currRound: int) -> str:
        """Get the output file name for the given round."""
        baseOutputFile = self.agentConfig.outputNameOverride or self.agentConfig.inputFile
        return getOutputFileName(
            baseOutputFile,
            self.agentConfig.agent,
            self.modelHandler.config.name,
            self.agentSetting.outputExt,
            currRound,
            self.agentConfig.editedFile,
        )

    def handleOutput(
        self,
        stateRound: AgentStateRound,  # Current round state object
        stateGlobal: AgentStateGlobal,  # Global state object
        outputFile: str,  # Path to output file
        endTurn: bool,  # Flag indicating end of turn
        currRound: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if endTurn:
            self._processOutputFiles(outputFile, currRound)

        # Call base implementation for database updates
        return super().handleOutput(stateRound, stateGlobal, outputFile, endTurn, currRound)
