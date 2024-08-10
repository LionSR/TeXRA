from coauthor.base_agents import ThinkAndWrite, DirectWrite
import coauthor as coa
import os

agent_path = coa.get_agent_path(coa, "prl")


class ReplyPRLBase:
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        
        # Ensure all file paths are provided before reading
        required_files = [
            "preamble",
            "input_file",
            "supp_file",
            "cover_letter",
            "editor_letter",
            "report_a",
            "report_b",
            "example_rebuttal_letter",
            "instruction",
        ]
        for file_arg in required_files:
            file_path = getattr(self.args, file_arg, None)
            if file_path and os.path.exists(file_path):
                user_vars[file_arg.upper() + "_FILE"] = file_path
                content = coa.read_file(file_path)
                if file_arg == "input_file":
                    user_vars["MAIN_CONTENT"] = content
                elif file_arg == "supp_file":
                    user_vars["SUPP_CONTENT"] = content
                elif file_arg == "cover_letter":
                    user_vars["COVER_LETTER"] = content
                elif file_arg == "editor_letter":
                    user_vars["EDITOR_LETTER"] = content
                elif file_arg == "report_a":
                    user_vars["REFEREE_REPORT_A"] = content
                elif file_arg == "report_b":
                    user_vars["REFEREE_REPORT_B"] = content
                elif file_arg == "example_rebuttal_letter":
                    user_vars["EXAMPLE_REPLY_LETTER"] = content
                elif file_arg == "instruction":
                    user_vars["INSTRUCTION"] = content
                else:
                    user_vars[file_arg.upper() + "_CONTENT"] = content

        # Handle specific agent-related file reads
        if "revise" in self.args.agent or "polish" in self.args.agent:
            if self.args.draft_reply_letter:
                user_vars["DRAFT_REPLY_LETTER"] = coa.read_file(self.args.draft_reply_letter)

        if "polish" in self.args.agent and self.args.main_content:
            user_vars["MAIN_CONTENT"] = coa.read_file(self.args.main_content)

        if self.args.agent == "revise_supp" and self.args.draft_main_content:
            user_vars["DRAFT_MAIN_CONTENT"] = coa.read_file(self.args.draft_main_content)

        return user_vars


class ReplyPRLThink(ReplyPRLBase, ThinkAndWrite):
    pass


class ReplyPRLDirect(ReplyPRLBase, DirectWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="reply_letter",
        help="Mode of operation.",
        choices=["draft_rebuttal", "reply_letter", "revise_main", "revise_supp", "polish_reply", "revise_prl"],
    )
    parser.add_argument("--preamble_file", type=str, default="preamble.tex", help="Path to the LaTeX preamble file.")
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file, if different from input_file.")
    parser.add_argument("--supp_file", type=str, default="supp.tex", help="Path to the supplementary TeX file.")

    parser.add_argument("--cover_letter", type=str, default="replies/cover_letter.txt", help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, default="replies/editor_letter.txt", help="Path to the editor decision letter file.")
    parser.add_argument("--report_a", type=str, default="replies/report_a.txt", help="Path to the first referee report file.")
    parser.add_argument("--report_b", type=str, default="replies/report_b.txt", help="Path to the second referee report file.")
    parser.add_argument("--example_rebuttal_letter", type=str, default=f"{agent_path}/example_rebuttal_letter.txt", help="Path to an example rebuttal letter file.")
    parser.add_argument("--instruction_file", type=str, default="replies/instruction.txt", help="Path to the instruction file.")
    args = parser.parse_args()

    if args.agent in ["reply_letter", "draft_rebuttal"]:
        reply_prl = ReplyPRLThink(args, agent_path)
    else:
        reply_prl = ReplyPRLDirect(args, agent_path)
    reply_prl.run()


if __name__ == "__main__":
    main()