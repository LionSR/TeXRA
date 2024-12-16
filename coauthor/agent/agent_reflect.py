from typing import List, Any

from .agent_base import BaseReflectChainAgent
from .agent_state import AgentRoundState, AgentGlobalState
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .output_handler import get_output_file_name


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(
        self,
        model_handler: Any,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        agent_path: str,
    ) -> None:
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        file_extension = "xml" if self.use_scratchpad else self.agent_settings.output_ext
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_handler.name, file_extension, round, self.agent_config.edited_file
        )

    def handle_output(
        self, round_state: AgentRoundState, global_state: AgentGlobalState, end_turn: bool, output_file: str, round: int = 0
    ) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            self.output_handler.ensure_correct_xml_structure(output_file, self.agent_settings.document_tag)

            if self.agent_config.output_files:
                processed_files = self.output_handler._process_multiple_outputs(output_file)
                self.output_handler._handle_multiple_outputs(processed_files)
                self.output_handler.output_files[round] = processed_files
                self.output_handler._replace_input_commands(self.base_files, processed_files)
                round_state.output_file = processed_files[0]  # Store first file as main output
            else:
                processed_file = self.output_handler._process_single_output(output_file)
                self.output_handler._handle_single_output(processed_file)
                self.output_handler.output_files[round] = [processed_file]
                round_state.output_file = processed_file

            self.output_handler._handle_latexdiff(round)

        # Call base implementation for database updates
        return super().handle_output(round_state, global_state, end_turn, output_file, round)


class DirectWrite(BaseReflectChainAgent):
    def __init__(
        self,
        model_handler: Any,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        agent_path: str,
    ) -> None:
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)

    def get_output_file(self, round: int) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_handler.name, self.agent_settings.output_ext, round, self.agent_config.edited_file
        )

    def handle_output(
        self, round_state: AgentRoundState, global_state: AgentGlobalState, end_turn: bool, output_file: str, round: int = 0
    ) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            if self.agent_config.output_files:
                processed_files = self.output_handler._process_multiple_outputs(output_file)
                self.output_handler._handle_multiple_outputs(processed_files)
                self.output_handler.output_files[round] = processed_files
                self.output_handler._replace_input_commands(self.base_files, processed_files)
                round_state.output_file = processed_files[0]  # Store first file as main output
            else:
                processed_file = self.output_handler._process_single_output(output_file)
                self.output_handler._handle_single_output(processed_file)
                self.output_handler.output_files[round] = [processed_file]
                round_state.output_file = processed_file

            self.output_handler._handle_latexdiff(round)

        # Call base implementation for database updates
        return super().handle_output(round_state, global_state, end_turn, output_file, round)
