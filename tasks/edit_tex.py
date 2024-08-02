from coauthor.base_tasks import ThinkWrite, DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "article")


class EditTexBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        if "multiple" in self.args.task:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars


class EditTexThink(EditTexBase, ThinkWrite):
    pass


class EditTexDirect(EditTexBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
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

    if args.task.startswith("correct"):
        edit_tex = EditTexDirect(args, prompt_path)
    else:
        edit_tex = EditTexThink(args, prompt_path)
    edit_tex.run()


if __name__ == "__main__":
    main()
