from coauthor.agent_reflect import DirectWrite
import coauthor as coa
import os
import re
from coauthor import State
from coauthor.logging_utils import logger

agent_path = coa.get_agent_path(coa, "merge")


def get_output_file_name_merge(input_file, edited_file, round):
    input_dir = os.path.dirname(input_file)
    input_base, _ = os.path.splitext(os.path.basename(input_file))
    edited_base, _ = os.path.splitext(os.path.basename(edited_file))

    parts = edited_base.split("_")
    edited_base_override = parts[0]
    agent = parts[1]  # Assuming the agent name is always the second part

    base = input_base
    if input_base != edited_base_override:
        base = edited_base_override

    round_match = re.search(r"_r(\d+)_", edited_base)
    round = int(round_match.group(1)) if round_match else round
    model = parts[-1]
    output = f"{base}_{agent}_r{round}_full_{model}.tex"

    output = os.path.join(input_dir, output)
    logger.info(f"Merge output file: {output}")
    return output


class Merge(DirectWrite):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.task_config.input_file = args.input_file
        self.task_config.edited_file = args.edited_file
        self.output_file = [get_output_file_name_merge(self.task_config.input_file, self.task_config.edited_file, r) for r in range(2)]

    def get_user_vars(self):
        user_vars = super().get_user_vars()
        user_vars.update(
            {
                "INPUT_CONTENT": coa.read_file(self.task_config.input_file),
                "EDITED_CONTENT": coa.read_file(self.task_config.edited_file),
            }
        )
        return user_vars

    def get_output_file(self, round):
        return get_output_file_name_merge(self.task_config.input_file, self.task_config.edited_file, round)

    def handle_output(self, state: State, end_turn: bool, output_file: str, round: int = 0) -> None:
        if end_turn:
            super().handle_output(state, end_turn, output_file, round)
            logger.info(f"Output file: {output_file}")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, default="merge", help="Agent to choose.")
    args = parser.parse_args()

    merge = Merge(args, agent_path)
    print(f"Merge args: {args}")
    merge.run()


if __name__ == "__main__":
    main()
