from coauthor.agent_reflect import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "lecture")


class EditLectureBase:
    def get_user_vars(self):
        user_vars = super().get_user_vars()

        # this can be turned into a conditional statement in the yaml file
        if hasattr(self.args, "edited_file") and self.args.edited_file:
            # in the future maybe it is better to also include the reasoning/scratchpad for this edited version
            user_vars["EDITED_CONTENT"] = coa.read_file(self.args.edited_file)
            user_vars[
                "EDITED_VERSION"
            ] = f"""
If you are iterating on a previous version, here is the content of the previously edited file:

<previous_edit>
{user_vars["EDITED_CONTENT"]}
</previous_edit>

Please analyze both the original input and this previous edit, focusing on further improvements and refinements.
"""
        else:
            user_vars["EDITED_VERSION"] = ""
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
        default="correct_st",
        choices=[
            "correct_qi",
            "correct_st",
            "correct_st_multiple",
            "polish_qi",
            "polish_st",
            "polish_st_multiple",
            "draw_qi",
            "draw_st",
            "draw_st_multiple",
            "revise_st",
            "revise_st_multiple",
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
