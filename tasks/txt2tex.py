from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "txt2tex")


class Txt2Tex(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "SAMPLE_TEX": coa.read_file(self.args.sample_tex) if self.args.sample_tex else "",
                "DOCUMENT_CLS_CONTENT": coa.read_file(self.args.document_cls) if self.args.document_cls else "",
                "COMMANDS_CONTENT": coa.read_file(self.args.commands_file) if self.args.commands_file else "",
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--existing_lecture_notes", type=str, help="Path to existing lecture notes in the desired style.")
    parser.add_argument("--document_cls", type=str, help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="txt2tex", choices=["txt2tex"], help="Task to perform, currently only 'txt2tex'.")
    args = parser.parse_args()

    txt2tex = Txt2Tex(args, prompt_path)
    txt2tex.run()


if __name__ == "__main__":
    main()
