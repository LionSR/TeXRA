# Local imports
from .agent_base import BaseReflectChainAgent
from .agent_config import AgentConfig
from .agent_dataclass import AgentSettings, AgentPrompts
from .agent_state import AgentStateRound, AgentStateGlobal
from .model_handler import ModelHandler
from .output_handler import get_output_file_name


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(
        self,
        # Core handlers/configs (required)
        model_handler: ModelHandler,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        # Path info (required)
        agent_path: str,
    ) -> None:
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, curr_round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        file_extension = "xml" if self.use_scratchpad else self.agent_settings.output_ext
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_handler.config.name, file_extension, curr_round, self.agent_config.edited_file
        )

    def handle_output(
        self,
        state_round: AgentStateRound,  # Current round state object
        state_global: AgentStateGlobal,  # Global state object
        output_file: str,  # Path to output file
        end_turn: bool,  # Flag indicating end of turn
        curr_round: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if end_turn:
            self.output_handler.ensure_correct_xml_structure(output_file, self.agent_settings.document_tag)
            self._process_output_files(output_file, curr_round)

        # Call base implementation for database updates
        return super().handle_output(state_round, state_global, output_file, end_turn, curr_round)


class DirectWrite(BaseReflectChainAgent):
    def __init__(
        self,
        # Core handlers/configs (required)
        model_handler: ModelHandler,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        # Path info (required)
        agent_path: str,
    ) -> None:
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, curr_round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        return get_output_file_name(
            base_output_file,
            self.agent_config.agent,
            self.model_handler.config.name,
            self.agent_settings.output_ext,
            curr_round,
            self.agent_config.edited_file,
        )

    def handle_output(
        self,
        state_round: AgentStateRound,  # Current round state object
        state_global: AgentStateGlobal,  # Global state object
        output_file: str,  # Path to output file
        end_turn: bool,  # Flag indicating end of turn
        curr_round: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if end_turn:
            self._process_output_files(output_file, curr_round)

        # Call base implementation for database updates
        return super().handle_output(state_round, state_global, output_file, end_turn, curr_round)
