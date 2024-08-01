import os
from coauthor.base_tasks import ThinkWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "article")


class EditTex(ThinkWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        if "multiple" in self.args.task:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def run(self):
        self.setup()
        state, messages = self.process()
        if self.args.reflect:
            state, messages = self.reflect(state, messages)
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
