from coauthor.agent_reflect import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "article")


class EditTexBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        if "multiple" in self.args.agent:
            coa.update_user_vars_multiple_output(self.args, user_vars)
        else:
            coa.update_user_vars_single_output(self.args, user_vars)

        if self.args.agent == "convert":
            if "iclr" in self.args.input_file:
                user_vars["ICLR_TEMPLATE"] = coa.read_file(self.args.input_file)
            if "neurips" in self.args.input_file:
                user_vars["NeurIPS_TEX"] = coa.read_file(self.args.input_file)
            for file in self.args.input_files:
                if "iclr" in file.lower():
                    user_vars["ICLR_TEMPLATE"] = coa.read_file(file)
                if "neurips" in file.lower():
                    user_vars["NeurIPS_TEX"] = coa.read_file(file)
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
            "convert",  # Add the new "convert" agent
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
