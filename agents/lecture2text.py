from coauthor.base_agents import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "lecture2text")


class Lecture2Text(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "DOCUMENT_CLS": "lecture.cls",
                "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
                "COMMANDS": "commands_qi.tex",
                "COMMANDS_CONTENT": coa.read_file("commands_qi.tex"),
            }
        )
        if self.args.agent in ["2tex", "reflect"]:
            user_vars["INPUT_CONTENT"] = coa.extract_text_from_tags(coa.read_file(self.args.input_file), "improved_document")
            user_vars.update(
                {
                    "corrected_transcription_content": coa.extract_text_from_tags(coa.read_file(self.args.input_file), "improved_document"),
                    "converted_tex_file": self.args.input_file.replace(".txt", ".tex"),
                    "converted_tex_content": coa.read_file(self.args.input_file.replace(".txt", ".tex")),
                }
            )
        elif self.args.agent in ["transcribe", "punctuate"]:
            user_vars["INPUT_CONTENT"] = coa.read_file(self.args.input_file)
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    args = parser.parse_args()

    lecture2text = Lecture2Text(args, agent_path)
    lecture2text.run()


if __name__ == "__main__":
    main()
