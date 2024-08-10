from coauthor.base_agents import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "article")


class EditTexBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        if "multiple" in self.args.agent:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars


class EditTexThink(EditTexBase, ThinkAndWrite):
    pass


class EditTexDirect(EditTexBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="correct",
        choices=[
            "correct",
            "polish",
            "draw",
            "polish_multiple",
            "polish_with_auxiliary",
            "correct_multiple",
            "correct_with_auxiliary",
            "draw_multiple",
            "draw_with_auxiliary",
        ],
    )
    args = parser.parse_args()

    if args.agent.startswith("correct"):
        edit_tex = EditTexDirect(args, agent_path)
    else:
        edit_tex = EditTexThink(args, agent_path)
    edit_tex.run()


if __name__ == "__main__":
    main()
