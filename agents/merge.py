from coauthor.base_agents import DirectWrite
import coauthor as coa
from termcolor import colored
import os
import re

agent_path = coa.get_agent_path(coa, "merge")


def get_output_file_name_merge(input_file, edited_file):
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
    round = int(round_match.group(1)) if round_match else 0
    model = parts[-1]
    output = f"{base}_{agent}_r{round}_full_{model}.tex"

    output = os.path.join(input_dir, output)
    print(f"Merge output file: {colored(output, 'cyan')}")
    return output


class Merge(DirectWrite):
    def __init__(self, args, agent_path):
        super().__init__(args, agent_path)
        self.input_file = args.input_file
        self.edited_file = args.edited_file
        self.output_file = get_output_file_name_merge(self.input_file, self.edited_file)

    def get_user_vars(self):
        user_vars = {
            "INPUT_FILE": self.input_file,
            "ORIGINAL_LATEX": coa.read_file(self.input_file),
            "EDITED_LATEX": coa.read_file(self.edited_file),
        }
        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def get_output_file(self):
        return get_output_file_name_merge(self.args.input_file, self.args.edited_file)

    def handle_output(self, state, end_turn, output_file, is_reflection_complete=False):
        if end_turn:
            super().handle_output(state, end_turn, output_file, is_reflection_complete)
            print(colored(f"Output file: {output_file}", "yellow"))


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--agent", type=str, default="merge", help="Agent to choose.")
    args = parser.parse_args()

    merge = Merge(args, agent_path)
    merge.run()


if __name__ == "__main__":
    main()
