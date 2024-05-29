import argparse
from termcolor import colored

from coauthor import read_file, extract_text_from_tags
import coauthor

# Define the settings for each mode
all_tasks_settings = {
    "transcribe": {
        "document_tag": "edited_transcript",
        "end_tag": "</edited_transcript>",
        "output_type": "txt",
        "first_prefill": "Here is the faithfully and correctly edited transcript:\n<edited_transcript>",
    },
}


def main():
    parser = argparse.ArgumentParser(description="AI-assisted transcription.")
    parser.add_argument(
        "input_file", type=str, help="Path to the INPUT file to be transcribed."
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model name to use for processing.",
        choices=["sonnet", "opus", "haiku"],
    )
    parser.add_argument(
        "--prompt_path",
        type=str,
        default="prompts/meeting2text",
        help="Path to the prompts directory.",
    )
    parser.add_argument(
        "--context_file",
        type=str,
        required=True,
        help="Path to the file containing the context for the discussion transcript.",
    )
    parser.add_argument(
        "--example_transcript",
        type=str,
        default="prompts/meeting2text/example_transcript.txt",
        help="Path to the example transcript file.",
    )
    parser.add_argument(
        "--example_edited_transcript",
        type=str,
        default="prompts/meeting2text/example_edited_transcript.txt",
        help="Path to the example edited transcript file.",
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_input_vars = {
        "INPUT_FILE": args.input_file,
        "TRANSCRIPT": read_file(args.input_file),
        "CONTEXT": read_file(args.context_file),
        "EXAMPLE_TRANSCRIPT": read_file(args.example_transcript),
        "EXAMPLE_EDITED_TRANSCRIPT": read_file(args.example_edited_transcript),
    }

    # Get the settings for the selected mode
    task_settings = all_tasks_settings["transcribe"]

    coauthor.process_file_with_claude(
        "transcribe",
        task_settings,
        args.input_file,
        user_prefix_input_vars,
        model=args.model,
        prompt_path=args.prompt_path,
    )


if __name__ == "__main__":
    main()