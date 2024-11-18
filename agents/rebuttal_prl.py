import coauthor as coa
import os

from coauthor.agent_reflect import ThinkAndWrite, DirectWrite

agent_path = coa.get_agent_path(coa, "prl")


class ReplyPRLBase:
    def setup(self):
        super().setup()

        if not self.args.output_files:
            self.args.output_files = ["replies/reply_to_editor.tex", "replies/reply_to_referees.tex", "replies/list_of_major_changes.tex"]

    def get_user_vars(self):
        user_vars = super().get_user_vars()

        # Ensure all file paths are provided before reading
        required_files = [
            "preamble",
            "input_file",
            "supp_file",
            "cover_letter",
            "editor_letter",
            "referee_report_a",
            "referee_report_b",
            "example_rebuttal_letter",
            "instruction_file",
        ]
        for file_arg in required_files:
            file_path = getattr(self.args, file_arg, None)
            if file_path and os.path.exists(file_path):
                if "file" not in file_arg:
                    user_vars[file_arg.upper() + "_FILE"] = file_path
                else:
                    user_vars[file_arg.upper()] = file_path

                content = coa.read_file(file_path)
                if file_arg == "input_file":
                    user_vars["MAIN_FILE"] = file_path
                    user_vars["MAIN_CONTENT"] = content
                elif file_arg == "supp_file":
                    user_vars["SUPP_FILE"] = file_path
                    user_vars["SUPP_CONTENT"] = content
                elif file_arg == "cover_letter":
                    user_vars["COVER_LETTER_FILE"] = file_path
                    user_vars["COVER_LETTER_CONTENT"] = content
                elif file_arg == "editor_letter":
                    user_vars["EDITOR_LETTER_FILE"] = file_path
                    user_vars["EDITOR_LETTER_CONTENT"] = content
                elif file_arg == "referee_report_a":
                    user_vars["REFEREE_REPORT_A_FILE"] = file_path
                    user_vars["REFEREE_REPORT_A_CONTENT"] = content
                elif file_arg == "referee_report_b":
                    user_vars["REFEREE_REPORT_B_FILE"] = file_path
                    user_vars["REFEREE_REPORT_B_CONTENT"] = content
                elif file_arg == "example_rebuttal_letter":
                    user_vars["EXAMPLE_REBUTTAL_LETTER_FILE"] = file_path
                    user_vars["EXAMPLE_REBUTTAL_LETTER_CONTENT"] = content
                elif file_arg == "instruction_file":
                    # user_vars["INSTRUCTION"] = content
                    if user_vars["INSTRUCTION"] is not None:
                        user_vars["INSTRUCTION"] = content + "\n\n" + user_vars["INSTRUCTION"]
                else:
                    user_vars[file_arg.upper() + "_CONTENT"] = content

        # Handle specific agent-related file reads
        if "revise" in self.args.agent or "polish" in self.args.agent:
            if self.args.reply_to_editor:
                user_vars["REPLY_TO_EDITOR_FILE"] = self.args.reply_to_editor
                user_vars["REPLY_TO_EDITOR"] = coa.read_file(self.args.reply_to_editor)
            if self.args.reply_to_referees:
                user_vars["REPLY_TO_REFEREES_FILE"] = self.args.reply_to_referees
                user_vars["REPLY_TO_REFEREES"] = coa.read_file(self.args.reply_to_referees)
            if self.args.list_of_major_changes:
                user_vars["LIST_OF_MAJOR_CHANGES_FILE"] = self.args.list_of_major_changes
                user_vars["LIST_OF_MAJOR_CHANGES"] = coa.read_file(self.args.list_of_major_changes)

        if "polish" in self.args.agent and self.args.main_content:
            user_vars["MAIN_CONTENT"] = coa.read_file(self.args.main_content)

        if self.args.agent == "revise_supp" and self.args.draft_main_content:
            user_vars["DRAFT_MAIN_CONTENT"] = coa.read_file(self.args.draft_main_content)

        user_vars["OUTPUT_FILES"] = self.args.output_files

        return user_vars


class ReplyPRLDirect(ReplyPRLBase, DirectWrite):
    pass


class ReplyPRLThink(ReplyPRLBase, ThinkAndWrite):
    pass


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="reply_letter",
        help="Mode of operation.",
        choices=["draft_rebuttal", "reply_letter", "revise_rebuttal", "revise_main", "revise_supp", "polish_reply", "revise_prl"],
    )
    parser.add_argument("--preamble_file", type=str, default="preamble.tex", help="Path to the LaTeX preamble file.")
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file, if different from input_file.")
    parser.add_argument("--supp_file", type=str, default="supp.tex", help="Path to the supplementary TeX file.")

    parser.add_argument("--cover_letter", type=str, default="replies/cover_letter.txt", help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, default="replies/editor_letter.txt", help="Path to the editor decision letter file.")
    parser.add_argument("--referee_report_a", type=str, default="replies/report_a.txt", help="Path to the first referee report file.")
    parser.add_argument("--referee_report_b", type=str, default="replies/report_b.txt", help="Path to the second referee report file.")
    parser.add_argument(
        "--example_rebuttal_letter", type=str, default=f"{agent_path}/example_rebuttal_letter.txt", help="Path to an example rebuttal letter file."
    )
    parser.add_argument("--instruction_file", type=str, default="replies/instruction_prl.txt", help="Path to the instruction file.")

    # New arguments for revise_rebuttal
    parser.add_argument("--reply_to_editor", type=str, default="replies/reply_to_editor.tex", help="Path to the current reply to editor file.")
    parser.add_argument("--reply_to_referees", type=str, default="replies/reply_to_referees.tex", help="Path to the current reply to referees file.")
    parser.add_argument(
        "--list_of_major_changes", type=str, default="replies/list_of_major_changes.tex", help="Path to the current list of major changes file."
    )

    args = parser.parse_args()

    for f in args.input_files:
        if "reply_to_editor" in f:
            args.reply_to_editor = f
        elif "reply_to_referees" in f:
            args.reply_to_referees = f
        elif "list_of_major_changes" in f:
            args.list_of_major_changes = f
        elif "instruction" in f:
            args.instruction_file = f

    if args.agent in ["reply_letter", "draft_rebuttal", "revise_rebuttal"]:
        reply_prl = ReplyPRLThink(args, agent_path)
    else:
        reply_prl = ReplyPRLDirect(args, agent_path)

    reply_prl.run()


if __name__ == "__main__":
    main()
