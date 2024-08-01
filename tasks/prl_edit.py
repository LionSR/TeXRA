from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl_edit")


class PRLEdit(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        user_vars.update({
            "PREAMBLE_CONTENT": coa.read_file(self.args.preamble_file),
        })
        if self.args.task == "correct_prl":
            user_vars.update({
                "SUPP_FILE": self.args.supp_file,
                "SUPP_CONTENT": coa.read_file(self.args.supp_file),
            })
        elif self.args.task == "correct_supp_prl":
            user_vars.update({
                "MAIN_FILE": self.args.auxiliary_files,
                "MAIN_CONTENT": coa.read_file(self.args.auxiliary_files),
            })
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--preamble_file", default="preamble.tex", type=str, help="Path to the preamble TeX file.")
    parser.add_argument("--auxiliary_files", type=str, help="Path to the auxiliary TeX file to be processed.")
    parser.add_argument("--supp_file", type=str, default="supp.tex", help="Path to the supplementary TeX file to be processed.")
    parser.add_argument(
        "--task",
        type=str,
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )
    args = parser.parse_args()

    prl_edit = PRLEdit(args, prompt_path)
    prl_edit.run()


if __name__ == "__main__":
    main()
