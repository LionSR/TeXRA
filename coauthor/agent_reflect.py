import os
import re
from typing import List

from .logdb_utils import logdb_and_print_statistics, logdb_output_files
from .agent_base import BaseReflectChainAgent
from .state import State
from .logging_utils import logger
from .agent_dataclass import AgentConfig
from .output_handler import get_output_file_name


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(self, config: AgentConfig, agent_path: str) -> None:
        super().__init__(config, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        file_extension = "xml" if self.use_scratchpad else self.agent_settings.output_ext
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_config.name, file_extension, round, self.agent_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
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

        logdb_output_files(output_file, self.log_file, self.output_handler.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_handler.output_files[round]


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, config: AgentConfig, agent_path: str) -> None:
        super().__init__(config, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override or self.agent_config.input_file
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_config.name, self.agent_settings.output_ext, round, self.agent_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
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

        logdb_output_files(output_file, self.log_file, self.output_handler.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_handler.output_files[round]
