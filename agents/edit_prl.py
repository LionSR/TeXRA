from coauthor.agent_reflect import ThinkAndWrite, DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "prl")


class EditPRLBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "PREAMBLE_FILE": self.args.preamble_file,
                "PREAMBLE_CONTENT": coa.read_file(self.args.preamble_file),
                "MAIN_FILE": self.args.input_file,
                "MAIN_CONTENT": coa.read_file(self.args.input_file),
                "SUPP_FILE": self.args.supp_file,
                "SUPP_CONTENT": coa.read_file(self.args.supp_file),
            }
        )
        return user_vars


class EditPRLThink(EditPRLBase, ThinkAndWrite):
    pass


class EditPRLDirect(EditPRLBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--preamble_file", default="preamble.tex", type=str, help="Path to the preamble TeX file.")
    parser.add_argument("--main_file", type=str, required=False, help="Path to the main TeX file to be processed.")
    parser.add_argument("--supp_file", type=str, required=False, help="Path to the supplementary TeX file to be processed.")
    parser.add_argument(
        "--agent", type=str, default="correct_prl", choices=["correct_prl", "polish_prl"], help="Mode of operation, 'correct_prl' or 'polish_prl'."
    )
    args = parser.parse_args()

    if not args.supp_file:
        for f in args.input_files:
            if "supp" in f:
                args.supp_file = f
                break

    if not args.output_files:
        args.output_files = [args.input_file, args.supp_file]

    if args.agent.startswith("correct"):
        edit_prl = EditPRLDirect(args, agent_path)
    else:
        edit_prl = EditPRLThink(args, agent_path)
    edit_prl.run()


if __name__ == "__main__":
    main()
