from coauthor.base_tasks import DirectWrite, ThinkWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "meeting2text")


class Meeting2Text(DirectWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "TRANSCRIPT": coa.read_file(self.args.input_file),
                "EXAMPLE_TRANSCRIPT": coa.read_file(self.args.example_transcript),
                "EXAMPLE_EDITED_TRANSCRIPT": coa.read_file(self.args.example_edited_transcript),
                "CONTEXT": self.args.instruction,
            }
        )

        # Add support for dual transcription
        if self.args.task == "transcribe_dual":
            user_vars.update(
                {
                    "WHISPER_INPUT_FILE": self.args.input_file,
                    "WHISPER_INPUT_CONTENT": coa.read_file(self.args.input_file),
                    "OTTER_INPUT_FILE": self.args.sample_files[0],
                    "OTTER_INPUT_CONTENT": coa.read_file(self.args.sample_files[0]),
                }
            )

        return user_vars


class Text2Tex(ThinkWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)
        user_vars.update(
            {
                "INPUT_CONTENT": coa.read_file(self.args.input_file),
                "CONTEXT": self.args.instruction,
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
    parser.add_argument("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
    parser.add_argument(
        "--task",
        type=str,
        default="transcribe",
        help="Task to perform: 'transcribe', 'transcribe_dual', or 'text2tex'.",
        choices=["transcribe", "transcribe_dual", "text2tex"],
    )
    args = parser.parse_args()

    if args.task == "transcribe_dual" and args.sample_files is None:
        parser.error("The transcribe_dual task requires --sample_files to be specified.")

    if args.task == "text2tex":
        text2tex = Text2Tex(args, prompt_path)
        text2tex.run()
    else:
        meeting2text = Meeting2Text(args, prompt_path)
        meeting2text.run()


if __name__ == "__main__":
    main()
