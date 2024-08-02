from coauthor.base_tasks import DirectWrite
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
            }
        )
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
    parser.add_argument("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
    parser.add_argument("--task", type=str, default="transcribe", help="Task to perform, currently only 'transcribe'.", choices=["transcribe"])
    args = parser.parse_args()

    meeting2text = Meeting2Text(args, prompt_path)
    meeting2text.run()


if __name__ == "__main__":
    main()
