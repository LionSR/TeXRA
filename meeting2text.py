import os
from termcolor import colored
import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path

# Define the settings for each mode
all_tasks_settings = {
    "transcribe": {
        "document_tag": "edited_transcript",
        "end_tag": "</edited_transcript>",
        "output_type": "md",
        "first_prefill": "Here is the faithfully and correctly edited transcript:\n<edited_transcript>",
    },
}

prompt_path = get_prompt_path(coauthor, "meeting2text")


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--context_file",
        type=str,
        required=True,
        help="Path to the file containing the context for the discussion transcript.",
    )
    parser.add_argument(
        "--example_transcript",
        type=str,
        # default="prompts/meeting2text/example_transcript.txt",
        default=None,
        help="Path to the example transcript file.",
    )
    parser.add_argument(
        "--example_edited_transcript",
        type=str,
        # default="prompts/meeting2text/example_edited_transcript.txt",
        default=None,
        help="Path to the example edited transcript file.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="txt2tex",
        help="Task to perform, currently only 'txt2tex'.",
        choices=["transcribe"],
    )
    parser.add_argument(
        "--append_mode",
        type=bool,
        default=True,
        help="Whether to append the output to the input file instead of overwriting it.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "TRANSCRIPT": read_file(args.input_file),
        "CONTEXT": read_file(args.context_file),
        "EXAMPLE_TRANSCRIPT": read_file(args.example_transcript)
        if args.example_transcript
        else "",
        "EXAMPLE_EDITED_TRANSCRIPT": read_file(args.example_edited_transcript)
        if args.example_edited_transcript
        else "",
    }

    # Get the settings for the selected mode
    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        reflect=args.reflect,
        append_mode=args.append_mode,
    )


if __name__ == "__main__":
    main()
