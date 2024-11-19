from coauthor.agent_reflect import DirectWrite, ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "meeting2text")


class Meeting2Text(DirectWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()

        if self.args.agent == "transcribe_one":
            user_vars.update(
                {
                    "TRANSCRIPT": coa.read_file(self.args.input_file),
                    "EXAMPLE_TRANSCRIPT": coa.read_file(self.args.sample_files[0]) if self.args.sample_files else None,
                    "EXAMPLE_EDITED_TRANSCRIPT": coa.read_file(self.args.sample_files[1]) if len(self.args.sample_files) > 1 else None,
                }
            )
        elif self.args.agent == "transcribe_dual":
            user_vars.update(
                {
                    "WHISPER_INPUT_FILE": self.args.input_file,
                    "WHISPER_INPUT_CONTENT": coa.read_file(self.args.input_file),
                    "OTTER_INPUT_FILE": self.args.sample_files[0],
                    "OTTER_INPUT_CONTENT": coa.read_file(self.args.sample_files[0]),
                }
            )

        return user_vars


class Text2Tex(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        user_vars.update(
            {
                "RESEARCH_NOTE": coa.read_file(self.args.sample_files[0]) if self.args.sample_files else None,
            }
        )
        return user_vars


class Text2TexDraft(Text2Tex):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        user_vars.update(
            {
                "TRANSCRIPT_CONTENT": coa.read_file(self.args.sample_files[0]) if self.args.sample_files else None,
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="transcribe_dual",
        help="Agent to choose: 'transcribe_one', 'transcribe_dual', 'text2tex', or 'text2tex_draft'.",
        choices=["transcribe_one", "transcribe_dual", "text2tex", "text2tex_draft"],
    )
    args = parser.parse_args()

    if args.agent == "transcribe_dual" and args.sample_files is None:
        parser.error("The transcribe_dual agent requires --sample_files to be specified.")

    if args.agent == "text2tex":
        text2tex = Text2Tex(args, agent_path)
        text2tex.run()
    elif args.agent == "text2tex_draft":
        text2tex_draft = Text2TexDraft(args, agent_path)
        text2tex_draft.run()
    else:
        meeting2text = Meeting2Text(args, agent_path)
        meeting2text.run()


if __name__ == "__main__":
    main()
