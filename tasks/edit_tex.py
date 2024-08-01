import os
from coauthor.base_tasks import ThinkWriteAndReflect
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "article")


class EditTex(ThinkWriteAndReflect):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        if "multiple" in self.args.task:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def handle_output(self, state, end_turn, output_file):
        if end_turn and self.output_settings["output_type"] == "tex":
            if "<scratchpad>" in self.output_settings["prefill_first"]:
                coa.ensure_correct_xml_structure(output_file, self.task_settings["document_tag"])
                output_files = coa.split_scratchpad_output_xml(output_file, self.task_settings["document_tag"])

                if isinstance(output_files, list):  # Multiple output files
                    for input_file, output_file in zip(self.args.output_files, output_files):
                        coa.log_output_files(output_file, self.log_file)
                        coa.run_latexdiff(input_file, output_file, self.args.task)
                else:  # Single output file
                    output_file = output_files
                    coa.run_latexdiff(self.args.input_file, output_file, self.args.task)
            else:
                coa.run_latexdiff(self.args.input_file, output_file, self.args.task)

        coa.log_output_files(output_file, self.log_file)
        coa.log_and_print_statistics(state, self.args.model, self.log_file)

        # Add latexdiff comparison between first output and reflected output
        if self.args.reflect and end_turn:
            first_output = coa.get_output_file_name(self.args.input_file, self.args.task, self.model_settings["model"], self.output_settings["output_type"])
            reflect_output = coa.get_output_file_name(self.args.input_file, self.args.task, self.model_settings["model"], self.output_settings["output_type"], reflect=True)
            if os.path.exists(first_output) and os.path.exists(reflect_output):
                coa.run_latexdiff(first_output, reflect_output, f"{self.args.task}_reflect_diff", self.args.model)
            else:
                print(f"Warning: Could not generate latexdiff for reflection. Files not found: {first_output} or {reflect_output}")

    def run(self):
        self.setup()
        state, messages = self.process()
        coa.log_end(self.log_file)


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct",
        choices=["correct", "polish", "draw", "polish_long", "draw_long", "polish_multiple"],
    )
    args = parser.parse_args()

    edit_tex = EditTex(args, prompt_path)
    edit_tex.run()


if __name__ == "__main__":
    main()
