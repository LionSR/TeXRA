import os
import re
from typing import Any, List, Optional

from ..logger import logger

from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_state import AgentRoundState, AgentGlobalState
from .agent_reflect import DirectWrite


class AgentMerge(DirectWrite):
    def __init__(
        self,
        model_handler: Any,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        agent_path: str,
    ) -> None:
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)
        self.output_file = [self.get_output_file(r) for r in range(2)]

    def get_output_file(self, round: int) -> str:
        """Get the output file name for the given round.

        Args:
            round: The round number (0 for first round, 1 for reflection)

        Returns:
            str: The path to the output file

        Raises:
            ValueError: If edited_file is not properly formatted
        """
        input_file = self.agent_config.input_file
        edited_file = self.agent_config.edited_file

        if not edited_file:
            raise ValueError("edited_file must be specified for merge operations")

        input_dir = os.path.dirname(input_file)
        input_base, _ = os.path.splitext(os.path.basename(input_file))
        edited_base, _ = os.path.splitext(os.path.basename(edited_file))

        # Count number of underscores in edited_base
        parts = edited_base.split("_")
        underscore_count = edited_base.count("_")

        agent: Optional[str] = None
        edited_base_override = parts[0]

        if underscore_count == 3:
            # For cases like "base_agent_r1_model"
            agent = parts[1]
        else:
            # For cases like "MutualInfo_restructured_polish_r1_sonnet++"
            # Combine all parts before _r{N}_ as the agent name
            agent_parts = []
            for i, part in enumerate(parts[1:], 1):
                if part.startswith("r") and part[1:].isdigit():
                    agent = "_".join(agent_parts)
                    break
                agent_parts.append(part)

        if agent is None:
            raise ValueError(f"Could not extract agent name from edited file: {edited_file}")

        base = edited_base_override if input_base != edited_base_override else input_base

        round_match = re.search(r"_r(\d+)_", edited_base)
        if not round_match:
            raise ValueError(f"Could not extract round number from edited file: {edited_file}")

        round = int(round_match.group(1))
        model = parts[-1]

        output_file = f"{base}_{agent}_r{round}_full_{model}.tex"
        output_file = os.path.join(input_dir, output_file)
        logger.info(f"Merge output file: {output_file}")
        return output_file

    def handle_output(
        self, round_state: AgentRoundState, global_state: AgentGlobalState, end_turn: bool, output_file: str, round: int = 0
    ) -> List[str]:
        """Handle the output for the given round.

        Args:
            round_state: The state for the current round
            global_state: The global state across all rounds
            end_turn: Whether this is the end of a turn
            output_file: The output file path
            round: The round number

        Returns:
            List[str]: List of processed output files
        """
        if end_turn:
            _files = super().handle_output(round_state, global_state, end_turn, output_file, round)
            logger.info(f"Output file: {output_file}")
            return _files
        return []
