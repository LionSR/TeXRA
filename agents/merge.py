import coauthor as coa
from coauthor import State
from coauthor.agent_reflect import DirectWrite
from coauthor.logging_utils import logger
from coauthor.agent_reflect import get_output_file_name_merge

agent_path = coa.get_agent_path(coa, ".")


class Merge(DirectWrite):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.output_file = [get_output_file_name_merge(self.agent_config.input_file, self.agent_config.edited_file, r) for r in range(2)]

    def get_output_file(self, round):
        return get_output_file_name_merge(self.agent_config.input_file, self.agent_config.edited_file, round)

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
