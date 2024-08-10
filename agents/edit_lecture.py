from coauthor.base_agents import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "lecture")


class EditLectureBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "DOCUMENT_CLS": "lecture.cls",
                "COMMANDS": "commands_qi.tex" if "qi" in self.args.agent else "command.tex",
            }
        )
        user_vars.update(
            {
                "DOCUMENT_CLS_CONTENT": coa.read_file(user_vars["DOCUMENT_CLS"]),
                "COMMANDS_CONTENT": coa.read_file(user_vars["COMMANDS"]),
            }
        )
        if "multiple" in self.args.agent:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars


class EditLectureThink(EditLectureBase, ThinkAndWrite):
    pass


class EditLectureDirect(EditLectureBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
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

    if args.agent.startswith("correct"):
        edit_lecture = EditLectureDirect(args, agent_path)
    else:
        edit_lecture = EditLectureThink(args, agent_path)
    edit_lecture.run()


if __name__ == "__main__":
    main()
