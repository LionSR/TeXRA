from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl_edit")


class PRLEdit(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "PREAMBLE_CONTENT": coa.read_file(self.args.preamble),
                "MAIN_FILE": self.args.main_file,
                "MAIN_CONTENT": coa.read_file(self.args.main_file),
                "SUPP_FILE": self.args.supp_file,
                "SUPP_CONTENT": coa.read_file(self.args.supp_file),
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--preamble", default="preamble.tex", type=str, help="Path to the preamble TeX file.")
    parser.add_argument("--main_file", type=str, required=True, help="Path to the main TeX file to be processed.")
    parser.add_argument("--supp_file", type=str, required=True, help="Path to the supplementary TeX file to be processed.")
    parser.add_argument("--task", type=str, default="correct_prl", help="Mode of operation, 'correct_prl' for both main and supplementary materials.")
    args = parser.parse_args()

    prl_edit = PRLEdit(args, prompt_path)
    prl_edit.run()


if __name__ == "__main__":
    main()
