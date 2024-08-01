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
