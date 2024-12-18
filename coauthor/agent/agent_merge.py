import os
import re

from ..logger import logger
from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_reflect import DirectWrite
from .agent_state import AgentRoundState, AgentGlobalState
from .model_operations import ModelOperations


class AgentMerge(DirectWrite):
    """Agent for merging multiple edited files into a single output."""

    def __init__(
        self,
        model_operations: ModelOperations,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        agent_path: str,
    ) -> None:
        """Initialize merge agent with model operations, configs, settings, prompts and path."""
        super().__init__(model_operations, agent_config, agent_settings, agent_prompts, agent_path)
        self.output_file = [self.get_output_file(r) for r in range(2)]

    def get_output_file(self, round: int) -> str:
        """Generate output filename for merged content from base_agent_r1_model or MutualInfo_restructured_polish_r1_sonnet++ formats."""
        input_file = self.agent_config.input_file
        edited_file = self.agent_config.edited_file

        if not edited_file:
            raise ValueError("edited_file must be specified for merge operations")

        input_dir = os.path.dirname(input_file)
        input_base, _ = os.path.splitext(os.path.basename(input_file))
        edited_base, _ = os.path.splitext(os.path.basename(edited_file))

        parts = edited_base.split("_")
        underscore_count = edited_base.count("_")
        edited_base_override = parts[0]

        # Extract agent name based on filename pattern
        agent = self._extract_agent_name(parts, underscore_count)
        if agent is None:
            raise ValueError(f"Could not extract agent name from edited file: {edited_file}")

        # Use override base name if different from input
        base = edited_base_override if input_base != edited_base_override else input_base

        # Extract round number
        round_match = re.search(r"_r(\d+)_", edited_base)
        if not round_match:
            raise ValueError(f"Could not extract round number from edited file: {edited_file}")

        round_num = int(round_match.group(1))
        model = parts[-1]

        output_file = f"{base}_{agent}_r{round_num}_full_{model}.tex"
        output_file = os.path.join(input_dir, output_file)
        logger.info(f"Merge output file: {output_file}")
        return output_file

    def _extract_agent_name(self, parts: list[str], underscore_count: int) -> str | None:
        """Extract agent name from filename parts based on standard (base_agent_r1_model) or complex (MutualInfo_restructured_polish_r1_sonnet++) formats."""
        if underscore_count == 3:
            # Standard format: "base_agent_r1_model"
            return parts[1]

        # Complex format: "MutualInfo_restructured_polish_r1_sonnet++"
        agent_parts = []
        for i, part in enumerate(parts[1:], 1):
            if part.startswith("r") and part[1:].isdigit():
                return "_".join(agent_parts)
            agent_parts.append(part)
        return None

    def handle_output(
        self,
        round_state: AgentRoundState,
        global_state: AgentGlobalState,
        output_file: str,
        end_turn: bool,
        round: int = 0,
    ) -> list[str]:
        """Process and handle output files for the current round."""
        if end_turn:
            _files = super().handle_output(round_state, global_state, output_file, end_turn, round)
            logger.info(f"Output file: {output_file}")
            return _files
        return []
