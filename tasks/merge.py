from coauthor.base_tasks import DirectWrite
import coauthor as coa
from termcolor import colored
import os

prompt_path = coa.get_prompt_path(coa, "merge")


def get_output_file_name_merge(input_file, edited_file):
    input_dir = os.path.dirname(input_file)
    input_base, _ = os.path.splitext(os.path.basename(input_file))
    edited_base, _ = os.path.splitext(os.path.basename(edited_file))

    parts = edited_base.split("_")
    edited_base_override = parts[0]
    task = parts[1]  # Assuming the task is always the second part

    base = input_base
    if input_base != edited_base_override:
        base = edited_base_override

    if "reflect" in parts:
        model = parts[-1]
        output = f"{base}_{task}_reflect_full_{model}.tex"
    else:
        model = parts[-1]
        output = f"{base}_{task}_full_{model}.tex"

    output = os.path.join(input_dir, output)
    print(f"Merge output file: {colored(output, 'cyan')}")
    return output


class Merge(DirectWrite):
    def get_user_vars(self):
        user_vars = {
            "INPUT_FILE": self.args.input_file,
            "ORIGINAL_LATEX": coa.read_file(self.args.input_file),
            "EDITED_LATEX": coa.read_file(self.args.edited_file),
        }
        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def get_output_file(self):
        return coa.get_output_file_name_merge(self.args.input_file, self.args.edited_file)

    def handle_output(self, state, end_turn, output_file):
        super().handle_output(state, end_turn, output_file)
        print(colored(f"Output file: {output_file}", "yellow"))


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--task", type=str, default="merge", help="Task to perform.")
    args = parser.parse_args()

    merge = Merge(args, prompt_path)
    merge.run()


if __name__ == "__main__":
    main()
