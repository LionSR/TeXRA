import os
import re

from typing import Optional, List

from .logdb_utils import logdb_and_print_statistics, logdb_output_files
from .agent_base import BaseReflectChainAgent
from .file_utils import read_file, write_file
from .output_utils import (
    ensure_correct_xml_structure,
    filter_monologue_tags,
    split_multiple_scratchpad_output_xml,
    split_scratchpad_output_xml,
)
from .state import State
from .logging_utils import logger
from .agent_dataclass import AgentConfig


def get_output_file_name(input_file: str, agent: str, model: str, output_ext: str, round: int, edited_file: Optional[str] = None) -> str:
    file_name, _ = os.path.splitext(input_file)
    agent_first_name_chunk = agent.split("_")[0]

    if edited_file:
        # Extract the round number from the edited file
        match = re.search(r"_r(\d+)_", edited_file)
        edited_round = int(match.group(1)) if match else 0
        new_round = edited_round + round + 1
    else:
        new_round = round

    output_file = f"{file_name}_{agent_first_name_chunk}_r{new_round}_{model}.{output_ext}"
    logger.debug(f"Output file: {output_file}")
    return output_file


class ThinkAndWrite(BaseReflectChainAgent):
    def __init__(self, config: AgentConfig, agent_path: str) -> None:
        super().__init__(config, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        base_output_file = self.agent_config.output_name_override if self.agent_config.output_name_override else self.agent_config.input_file
        file_extension = self.agent_settings.output_ext
        if self.use_scratchpad:
            file_extension = "xml"
        else:
            file_extension = self.agent_settings.output_ext

        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_config.name, file_extension, round, self.agent_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            ensure_correct_xml_structure(output_file, self.agent_settings.document_tag)

            if self.agent_config.output_files:
                processed_output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                # Filter monologue tags from each output file
                for processed_output_file in processed_output_files:
                    content = read_file(processed_output_file)
                    filtered_content = filter_monologue_tags(content)
                    write_file(processed_output_file, filtered_content)

                self._handle_multiple_outputs(processed_output_files)
                self.output_files[round] = processed_output_files
                self._replace_input_commands(self.base_files, processed_output_files)
            else:
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                # Filter monologue tags from single output file
                content = read_file(processed_output_file)
                filtered_content = filter_monologue_tags(content)
                write_file(processed_output_file, filtered_content)

                self._handle_single_output(processed_output_file)
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        logdb_output_files(output_file, self.log_file, self.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)
        return self.output_files[round]


class DirectWrite(BaseReflectChainAgent):
    def __init__(self, config: AgentConfig, agent_path: str) -> None:
        super().__init__(config, agent_path)

    def get_output_file(self, round: int = 0) -> str:
        """Get the output file name for the given round."""
        file_extension = self.agent_settings.output_ext
        base_output_file = self.agent_config.output_name_override if self.agent_config.output_name_override else self.agent_config.input_file
        return get_output_file_name(
            base_output_file, self.agent_config.agent, self.model_config.name, file_extension, round, self.agent_config.edited_file
        )

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> List[str]:
        """Handle the output for the given round."""
        if end_turn:
            if self.agent_config.output_files:  # Multiple output files
                output_files = split_multiple_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                # Filter monologue tags from each output file
                for output_file in output_files:
                    content = read_file(output_file)
                    filtered_content = filter_monologue_tags(content)
                    write_file(output_file, filtered_content)

                self._handle_multiple_outputs(output_files)
                self.output_files[round] = output_files
                self.output_file[round] = output_files[0]  # Set the first file as the singular output

                self._replace_input_commands(self.base_files, output_files)
            else:  # Single output file
                processed_output_file = split_scratchpad_output_xml(output_file, self.agent_settings.document_tag)
                # Filter monologue tags from single output file
                content = read_file(processed_output_file)
                filtered_content = filter_monologue_tags(content).strip()
                write_file(processed_output_file, filtered_content)

                self._handle_single_output(processed_output_file)
                self.output_file[round] = processed_output_file
                self.output_files[round] = [processed_output_file]

            self._handle_latexdiff(round)

        logdb_output_files(output_file, self.log_file, self.output_files[round])
        logdb_and_print_statistics(state, self.model_config, self.log_file)

        return self.output_files[round]
