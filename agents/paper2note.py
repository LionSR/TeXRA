from coauthor.base_agents import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "paper2note")


class Paper2Note(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "SAMPLE_TEX": "\n".join([coa.read_file(ch) for ch in self.args.sample_chapters]) if self.args.sample_chapters else None,
                "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
                "COMMANDS_CONTENT": coa.read_file("command.tex"),
            }
        )
        user_vars.update(
            {
                "EXAMPLE_PAPER": coa.read_file(self.args.example_paper),
                "EXAMPLE_LECTURE_NOTE": coa.read_file(self.args.example_lecture_note),
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_chapters", type=str, nargs="+", help="Paths to the sample chapter TeX files.")
    parser.add_argument("--example_paper", type=str, help="Path to an example research paper.")
    parser.add_argument("--example_lecture_note", type=str, help="Path to an example lecture note corresponding to the example paper.")
    parser.add_argument(
        "--agent",
        type=str,
        default="paper2note",
        help="Agent to choose, either 'paper2note' or 'paper2note_example'.",
        choices=["paper2note", "paper2note_example"],
    )
    args = parser.parse_args()

    paper2note = Paper2Note(args, agent_path)
    paper2note.run()


if __name__ == "__main__":
    main()
