import os
import re

from .state import State
from .agent_reflect import DirectWrite
from .logging_utils import logger


def get_output_file_name_merge(input_file, edited_file, round):
    input_dir = os.path.dirname(input_file)
    input_base, _ = os.path.splitext(os.path.basename(input_file))
    edited_base, _ = os.path.splitext(os.path.basename(edited_file))

    # Count number of underscores in edited_base
    underscore_count = edited_base.count("_")

    parts = edited_base.split("_")
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


class AgentMerge(DirectWrite):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.output_file = [get_output_file_name_merge(self.agent_config.input_file, self.agent_config.edited_file, r) for r in range(2)]

    def get_output_file(self, round):
        return get_output_file_name_merge(self.agent_config.input_file, self.agent_config.edited_file, round)

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> None:
        if end_turn:
            super().handle_output(state, end_turn, output_file, round)
            logger.info(f"Output file: {output_file}")
