# Local imports
from .agent_base import BaseReflectChainAgent
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_state import AgentRoundState, AgentGlobalState
from .model_operations import ModelOperations
from .output_handler import get_output_file_name


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(
        self,
        # Core handlers/configs (required)
        model_operations: ModelOperations,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        # Path info (required)
        agent_path: str,
    ) -> None:
        super().__init__(model_operations, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        file_extension = "xml" if self.use_scratchpad else self.agent_settings.output_ext
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_operations.config.name, file_extension, round, self.agent_config.edited_file
        )

    def handle_output(
        self,
        round_state: AgentRoundState,  # Current round state object
        global_state: AgentGlobalState,  # Global state object
        output_file: str,  # Path to output file
        end_turn: bool,  # Flag indicating end of turn
        round: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if end_turn:
            self.output_handler.ensure_correct_xml_structure(output_file, self.agent_settings.document_tag)

            if self.agent_config.output_files:
                processed_files = self.output_handler._process_multiple_outputs(output_file)
                self.output_handler._handle_multiple_outputs(processed_files)
                self.output_handler.output_files[round] = processed_files
                self.output_handler._replace_input_commands(self.base_files, processed_files)
            else:
                processed_file = self.output_handler._process_single_output(output_file)
                self.output_handler._handle_single_output(processed_file)
                self.output_handler.output_files[round] = [processed_file]

            self.output_handler._handle_latexdiff(round)

        # Call base implementation for database updates
        return super().handle_output(round_state, global_state, output_file, end_turn, round)


class DirectWrite(BaseReflectChainAgent):
    def __init__(
        self,
        # Core handlers/configs (required)
        model_operations: ModelOperations,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        # Path info (required)
        agent_path: str,
    ) -> None:
        super().__init__(model_operations, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        return get_output_file_name(
            base_output_file,
            self.agent_config.agent,
            self.model_operations.config.name,
            self.agent_settings.output_ext,
            round,
            self.agent_config.edited_file,
        )

    def handle_output(
        self,
        round_state: AgentRoundState,  # Current round state object
        global_state: AgentGlobalState,  # Global state object
        output_file: str,  # Path to output file
        end_turn: bool,  # Flag indicating end of turn
        round: int = 0,  # Current round number
    ) -> list[str]:
        """Handle the output for the given round."""
        if end_turn:
            if self.agent_config.output_files:
                processed_files = self.output_handler._process_multiple_outputs(output_file)
                self.output_handler._handle_multiple_outputs(processed_files)
                self.output_handler.output_files[round] = processed_files
                self.output_handler._replace_input_commands(self.base_files, processed_files)
            else:
                processed_file = self.output_handler._process_single_output(output_file)
                self.output_handler._handle_single_output(processed_file)
                self.output_handler.output_files[round] = [processed_file]

            self.output_handler._handle_latexdiff(round)

        # Call base implementation for database updates
        return super().handle_output(round_state, global_state, output_file, end_turn, round)
