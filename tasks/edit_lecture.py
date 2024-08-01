import os
from coauthor.base_tasks import ThinkWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "lecture")


class EditLecture(ThinkWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        user_vars.update(
            {
                "DOCUMENT_CLS": "lecture.cls",
                "COMMANDS": "commands_qi.tex" if "qi" in self.args.task else "command.tex",
            }
        )
        user_vars.update(
            {
                "DOCUMENT_CLS_CONTENT": coa.read_file(user_vars["DOCUMENT_CLS"]),
                "COMMANDS_CONTENT": coa.read_file(user_vars["COMMANDS"]),
            }
        )
        if "multiple" in self.args.task:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def handle_output(self, state, end_turn, output_file, is_reflection_complete=False):
        super().handle_output(state, end_turn, output_file, is_reflection_complete)

        if end_turn and self.output_settings["output_type"] == "tex":
            if self.args.output_files:  # Multiple output files
                for input_file, output_file in zip(self.args.output_files, self.first_round_output_files):
                    coa.run_latexdiff(input_file, output_file, self.args.task)
            else:  # Single output file
                coa.run_latexdiff(self.args.input_file, output_file, self.args.task)

    def _handle_reflection_diff(self, end_turn):
        super()._handle_reflection_diff(end_turn)
        if self.output_settings["output_type"] == "tex":
            if self.args.output_files:  # Multiple output files
                for first_output, reflect_output in zip(self.first_round_output_files, self.reflect_round_output_files):
                    coa.run_latexdiff(first_output, reflect_output, f"{self.args.task}_reflect_diff", self.args.model)
            else:  # Single output file
                first_output = self.get_output_file()
                reflect_output = self.get_output_file_reflect()
                if os.path.exists(first_output) and os.path.exists(reflect_output):
                    coa.run_latexdiff(first_output, reflect_output, f"{self.args.task}_reflect_diff", self.args.model)


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        choices=[
            "correct_qi",
            "correct_st",
            "polish_qi",
            "polish_st",
            "draw_st",
            "draw_qi",
            "polish_st_multiple",
            "draw_st_multiple",
            "correct_st_multiple",
        ],
    )
    args = parser.parse_args()

    edit_lecture = EditLecture(args, prompt_path)
    edit_lecture.run()


if __name__ == "__main__":
    main()
