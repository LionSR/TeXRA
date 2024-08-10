from coauthor.base_tasks import ThinkAndWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl")


class PRLEdit(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "PREAMBLE_CONTENT": coa.read_file(self.args.preamble),
                "MAIN_FILE": self.args.input_file,
                "MAIN_CONTENT": coa.read_file(self.args.input_file),
                "SUPP_FILE": self.args.supp_file,
                "SUPP_CONTENT": coa.read_file(self.args.supp_file),
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--preamble", default="preamble.tex", type=str, help="Path to the preamble TeX file.")
    parser.add_argument("--main_file", type=str, required=False, help="Path to the main TeX file to be processed.")
    parser.add_argument("--supp_file", type=str, required=False, help="Path to the supplementary TeX file to be processed.")
    parser.add_argument("--task", type=str, default="correct_prl", help="Mode of operation, 'correct_prl' for both main and supplementary materials.")
    args = parser.parse_args()

    # within args.input_files find the one that has supp and set it as supp_file is supp file is not given
    if not args.supp_file:
        for f in args.input_files:
            if "supp" in f:
                args.supp_file = f
                break

    if not args.output_files:
        args.output_files = [args.input_file, args.supp_file]

    prl_edit = PRLEdit(args, prompt_path)
    prl_edit.run()


if __name__ == "__main__":
    main()
