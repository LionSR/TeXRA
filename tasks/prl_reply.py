from coauthor.base_tasks import ThinkWrite, DirectWrite
import coauthor as coa
import os

prompt_path = coa.get_prompt_path(coa, "prl")


class PRLReplyBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        # Ensure all file paths are provided before reading
        required_files = [
            "preamble",
            "input_file",
            "supp_file",
            "instruction",
            "cover_letter",
            "editor_letter",
            "report_a",
            "report_b",
            "example_reply_letter",
            "draft_reply_letter",
        ]
        for file_arg in required_files:
            file_path = getattr(self.args, file_arg, None)
            if file_path and os.path.exists(file_path):
                user_vars[file_arg.upper() + "_FILE"] = file_path
                user_vars[file_arg.upper() + "_CONTENT"] = coa.read_file(file_path)

        # Handle specific task-related file reads
        if "revise" in self.args.task or "polish" in self.args.task:
            if self.args.draft_reply_letter:
                user_vars["DRAFT_REPLY_LETTER"] = coa.read_file(self.args.draft_reply_letter)

        if "polish" in self.args.task and self.args.main_content:
            user_vars["MAIN_CONTENT"] = coa.read_file(self.args.main_content)

        if self.args.task == "revise_supp" and self.args.draft_main_content:
            user_vars["DRAFT_MAIN_CONTENT"] = coa.read_file(self.args.draft_main_content)

        return user_vars


class PRLReplyThink(PRLReplyBase, ThinkWrite):
    pass


class PRLReplyDirect(PRLReplyBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file, if different from input_file.")
    parser.add_argument("--supp_file", type=str, help="Path to the supplementary TeX file.")
    parser.add_argument(
        "--task", type=str, default="reply_letter", help="Mode of operation.", choices=["reply_letter", "revise_main", "revise_supp", "polish_reply", "revise_prl"]
    )
    parser.add_argument("--cover_letter", type=str, required=True, help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, required=True, help="Path to the editor decision letter file.")
    parser.add_argument("--report_a", type=str, required=True, help="Path to the first referee report file.")
    parser.add_argument("--report_b", type=str, required=True, help="Path to the second referee report file.")
    parser.add_argument("--preamble", type=str, default="preamble.tex", help="Path to the LaTeX preamble file.")
    parser.add_argument("--example_reply_letter", type=str, default="rebuttal_example/reply_letter.txt", help="Path to an example reply letter file.")
    parser.add_argument("--draft_reply_letter", type=str, help="Path to the draft reply letter file.")
    parser.add_argument("--draft_main_content", type=str, help="Path to the draft main content file, if applicable.")
    args = parser.parse_args()

    if args.task == "reply_letter":
        prl_reply = PRLReplyThink(args, prompt_path)
    else:
        prl_reply = PRLReplyDirect(args, prompt_path)
    prl_reply.run()


if __name__ == "__main__":
    main()
