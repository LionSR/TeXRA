from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "paper2note")


class Paper2Note(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        user_vars.update(
            {
                "SAMPLE_CHAPTERS": "\n".join([coa.read_file(ch) for ch in self.args.sample_chapters]),
                "SAMPLE_PAPER": coa.read_file(self.args.sample_paper),
                "SAMPLE_NOTE": coa.read_file(self.args.sample_note),
                "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
                "COMMANDS_CONTENT": coa.read_file("command.tex"),
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_chapters", type=str, nargs="+", help="Paths to the sample chapter TeX files.")
    parser.add_argument("--sample_paper", type=str, help="Path to the sample research paper TeX file.")
    parser.add_argument("--sample_note", type=str, help="Path to the sample lecture note TeX file corresponding to the sample paper.")
    parser.add_argument("--task", type=str, default="paper2note", help="Task to perform, currently only 'paper2note'.", choices=["paper2note"])
    args = parser.parse_args()

    paper2note = Paper2Note(args, prompt_path)
    paper2note.run()


if __name__ == "__main__":
    main()
