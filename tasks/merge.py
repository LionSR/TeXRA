from coauthor.base_tasks import DirectWrite
import coauthor as coa
from termcolor import colored

prompt_path = coa.get_prompt_path(coa, "merge")


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
        if end_turn and self.output_settings["output_type"] == "tex":
            coa.run_latexdiff(self.args.input_file, output_file, self.args.task, self.args.model)

        print(colored(f"Output file: {output_file}", "yellow"))

        coa.log_output_files(output_file, self.log_file)
        coa.log_and_print_statistics(state, self.args.model, self.log_file)


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--task", type=str, default="merge", help="Task to perform.")
    args = parser.parse_args()

    merge = Merge(args, prompt_path)
    merge.run()


if __name__ == "__main__":
    main()
