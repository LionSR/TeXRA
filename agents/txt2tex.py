from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "txt2tex")


class Txt2Tex(DirectWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        user_vars.update(
            {
                "SAMPLE_TEX_CONTENT": coa.read_file(self.args.sample_tex),
                "DOCUMENT_CLS_CONTENT": coa.read_file(self.args.document_cls),
                "COMMAND_CONTENT": coa.read_file(self.args.commands_file),
                "TOPIC": self.args.topic,
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to the sample tex file in the desired style.")
    parser.add_argument("--document_cls", type=str, help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
    parser.add_argument(
        "--agent", type=str, default="txt2tex", choices=["txt2tex", "txt2tex_article", "txt2tex_paper", "txt2tex_example"], help="Agents to choose."
    )
    parser.add_argument("--topic", type=str, default="Experimental Quantum Computing", help="Topic of the document.")
    args = parser.parse_args()

    txt2tex = Txt2Tex(args, agent_path)
    txt2tex.run()


if __name__ == "__main__":
    main()
