from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl_reply")


class PRLReply(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "PREAMBLE_CONTENT": coa.read_file(self.args.preamble),
                "MAIN_CONTENT": coa.read_file(self.args.input_file),
                "SUPP_CONTENT": coa.read_file(self.args.supp_file) if self.args.supp_file else "",
                "INSTRUCTION": coa.read_file(self.args.instruction) if self.args.instruction else "",
                "COVER_LETTER": coa.read_file(self.args.cover_letter) if self.args.cover_letter else "",
                "EDITOR_DECISION_LETTER": coa.read_file(self.args.editor_letter) if self.args.editor_letter else "",
                "REFEREE_REPORT_A": coa.read_file(self.args.report_a) if self.args.report_a else "",
                "REFEREE_REPORT_B": coa.read_file(self.args.report_b) if self.args.report_b else "",
                "EXAMPLE_REPLY_LETTER": coa.read_file(self.args.example_reply_letter) if self.args.example_reply_letter else "",
            }
        )

        if "revise" in self.args.task or "polish" in self.args.task:
            user_vars["DRAFT_REPLY_LETTER"] = coa.read_file(self.args.draft_reply_letter) if self.args.draft_reply_letter else ""

        if "polish" in self.args.task:
            user_vars["MAIN_CONTENT"] = coa.read_file(self.args.main_content) if self.args.main_content else ""

        if self.args.task == "revise_supp":
            user_vars["SUPP_CONTENT"] = coa.read_file(self.args.input_file)
            user_vars["MAIN_CONTENT"] = coa.read_file(self.args.main_content) if self.args.main_content else ""
            user_vars["DRAFT_MAIN_CONTENT"] = coa.read_file(self.args.draft_main_content) if self.args.draft_main_content else ""

        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file to be included in the response.", default=None)
    parser.add_argument("--supp_file", type=str, help="Path to the supplementary TeX file to be included in the response.", default=None)
    parser.add_argument("--instruction", type=str, help="Path to the file containing the overall instruction.")
    parser.add_argument(
        "--task", type=str, default="reply_letter", help="Mode of operation.", choices=["reply_letter", "revise_main", "revise_supp", "polish_reply"]
    )
    parser.add_argument("--cover_letter", type=str, help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, help="Path to the editor letter file.")
    parser.add_argument("--report_a", type=str, help="Path to the referee report A file.")
    parser.add_argument("--report_b", type=str, help="Path to the referee report B file.")
    parser.add_argument("--preamble", type=str, default="preamble.tex", help="Path to the preamble file.")
    parser.add_argument("--example_reply_letter", type=str, default="rebuttal_example/reply_letter.txt", help="Path to the example reply letter file.")
    parser.add_argument("--draft_reply_letter", type=str, help="Path to the draft reply letter file.")
    parser.add_argument("--draft_main_content", type=str, help="Path to the draft main content file.")
    args = parser.parse_args()

    prl_reply = PRLReply(args, prompt_path)
    prl_reply.run()


if __name__ == "__main__":
    main()
