import os
import re

from ..logger import logger

from .agent_config import AgentConfig
from .agent_dataclass import AgentSettings, AgentPrompts
from .agent_reflect import DirectAgent
from .agent_state import AgentStateRound, AgentStateGlobal
from .model_handler import ModelHandler


class AgentMerge(DirectAgent):
    """Agent for merging multiple edited files into a single output."""

    def __init__(
        self,
        model_handler: ModelHandler,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        agent_prompts: AgentPrompts,
        agent_path: str,
    ) -> None:
        """Initialize merge agent with model handler, configs, settings, prompts and path."""
        super().__init__(model_handler, agent_config, agent_settings, agent_prompts, agent_path)
        self.output_file = [self.get_output_file(r) for r in range(2)]

    def _parse_filename_parts(self, edited_base: str) -> tuple[str, str, int, str]:
        """Parse filename parts to extract base name, agent, round number and model."""
        parts = edited_base.split("_")
        underscore_count = edited_base.count("_")
        base = parts[0]

        # Extract agent name
        agent = self._extract_agent_name(parts, underscore_count)
        if agent is None:
            raise ValueError(f"Could not extract agent name from edited base: {edited_base}")

        # Extract round number
        round_match = re.search(r"_r(\d+)_", edited_base)
        if not round_match:
            raise ValueError(f"Could not extract round number from edited base: {edited_base}")
        round_num = int(round_match.group(1))

        # Get model name (last part)
        model = parts[-1]

        return base, agent, round_num, model

    def get_output_file(self, curr_round: int) -> str:
        """Generate output filename for merged content."""
        input_file = self.agent_config.input_file
        edited_file = self.agent_config.edited_file

        if not edited_file:
            raise ValueError("edited_file must be specified for merge handler")

        input_dir = os.path.dirname(input_file)
        input_base, _ = os.path.splitext(os.path.basename(input_file))
        edited_base, _ = os.path.splitext(os.path.basename(edited_file))

        # Parse filename components
        base, agent, round_num, model = self._parse_filename_parts(edited_base)

        # Use original input base if it differs from edited base
        if input_base != base:
            base = input_base

        # Construct output filename
        output_file = f"{base}_{agent}_r{round_num}_full_{model}.tex"
        output_path = os.path.join(input_dir, output_file)
        logger.info(f"Merge output file: {output_path}")
        return output_path

    def _extract_agent_name(self, parts: list[str], underscore_count: int) -> str | None:
        """Extract agent name from filename parts.

        Handles two formats:
        - Standard: base_agent_r1_model
        - Complex: MutualInfo_restructured_polish_r1_sonnet++
        """
        if underscore_count == 3:
            # Standard format
            return parts[1]

        # Complex format - collect parts until round number
        agent_parts = []
        for i, part in enumerate(parts[1:], 1):
            if part.startswith("r") and part[1:].isdigit():
                return "_".join(agent_parts)
            agent_parts.append(part)
        return None

    def handle_output(
        self,
        state_round: AgentStateRound,
        state_global: AgentStateGlobal,
        output_file: str,
        end_turn: bool,
        curr_round: int = 0,
    ) -> list[str]:
        """Process and handle output files for the current round."""
        if end_turn:
            _files = super().handle_output(state_round, state_global, output_file, end_turn, curr_round)
            logger.info(f"Output file: {output_file}")
            return _files
        return []
