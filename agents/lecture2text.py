from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "lecture2text")


class Lecture2Text(DirectWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()

        if self.task_config.agent in ["2tex", "reflect"]:
            converted_tex_file = self.task_config.input_file.replace(".txt", ".tex")
            user_vars.update(
                {
                    "CONVERTED_TEX_FILE": converted_tex_file,
                    "CONVERTED_TEX_CONTENT": coa.read_file(converted_tex_file),
                }
            )
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
