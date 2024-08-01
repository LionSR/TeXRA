from coauthor.base_tasks import DirectWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "adapt")


class Adapt(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)
        user_vars.update(
            {
                "EXISTING_LECTURE_NOTES": coa.read_file(self.args.sample_tex),
                "DOCUMENT_CLS_CONTENT": coa.read_file(self.args.document_cls),
                "COMMANDS_CONTENT": coa.read_file(self.args.commands_file),
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, default="lecture.cls", help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, default="command.tex", help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="adapt", choices=["adapt"], help="Mode of operation, either 'adapt'.")
    args = parser.parse_args()

    adapt = Adapt(args, prompt_path)
    adapt.run()


if __name__ == "__main__":
    main()
