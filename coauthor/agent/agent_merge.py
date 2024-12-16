import os
import re
from typing import Any

from ..logger import logger

from .agent_dataclass import AgentConfig, AgentSettings, AgentPrompts
from .agent_state import AgentState
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
        input_file = self.agent_config.input_file
        edited_file = self.agent_config.edited_file

        input_dir = os.path.dirname(input_file)
        input_base, _ = os.path.splitext(os.path.basename(input_file))
        edited_base, _ = os.path.splitext(os.path.basename(edited_file))

        # Count number of underscores in edited_base
        parts = edited_base.split("_")
        underscore_count = edited_base.count("_")

        if underscore_count == 3:
            # For cases like "base_agent_r1_model"
            edited_base_override = parts[0]
            agent = parts[1]
        else:
            # For cases like "MutualInfo_restructured_polish_r1_sonnet++"
            # Combine all parts before _r{N}_ as the agent name
            agent_parts = []
            edited_base_override = parts[0]
            for i, part in enumerate(parts[1:], 1):
                if part.startswith("r") and part[1:].isdigit():
                    agent = "_".join(agent_parts)
                    break
                agent_parts.append(part)

        base = input_base
        if input_base != edited_base_override:
            base = edited_base_override

        round_match = re.search(r"_r(\d+)_", edited_base)
        round = int(round_match.group(1)) if round_match else round
        model = parts[-1]

        output_file = f"{base}_{agent}_r{round}_full_{model}.tex"
        output_file = os.path.join(input_dir, output_file)
        logger.info(f"Merge output file: {output_file}")
        return output_file

    def handle_output(self, state: AgentState, end_turn: bool, output_file: str, round: int = 0):
        if end_turn:
            _files = super().handle_output(state, end_turn, output_file, round)
            logger.info(f"Output file: {output_file}")
            return _files
