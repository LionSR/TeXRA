# txt2tex.py
import os
from termcolor import colored

from coauthor import read_file
import coauthor
from coauthor.argparse_utils import get_common_argparser

all_tasks_settings = {
    "txt2tex": {
        "document_tag": "txt_content",
        "end_tag": "</latex_content>",
        "output_type": "tex",
        "first_prefill": "<latex_content> \\chapter",
    },
}

prompt_path = os.path.join(os.path.dirname(coauthor.__file__), "prompts/txt2tex")


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--input_file",
        type=str,
        help="Path to the text file generated from the PDF.",
    )
    parser.add_argument(
        "--sample_tex",
        type=str,
        help="Path to a sample LaTeX file in the desired style.",
    )
    parser.add_argument(
        "--document_cls",
        type=str,
        help="Path to the document class file.",
    )
    parser.add_argument(
        "--commands_file",
        type=str,
        help="Path to the file containing custom LaTeX commands.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="txt2tex",
        help="Task to perform, currently only 'txt2tex'.",
        choices=["txt2tex"],
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Converting {args.input_file} to LaTeX...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "EXISTING_LECTURE_NOTES": read_file(args.sample_tex) if args.sample_tex else "",
        "DOCUMENT_CLS_CONTENT": (
            read_file(args.document_cls) if args.document_cls else ""
        ),
        "COMMANDS_CONTENT": read_file(args.commands_file) if args.commands_file else "",
    }

    task_settings = all_tasks_settings[args.task]

    coauthor.process_file_with_llm(
        args.task,
        task_settings,
        args.input_file,
        user_prefix_vars,
        model=args.model,
        prompt_path=prompt_path,
        reflect=args.reflect,
        use_prefill_from_input=False,
    )


if __name__ == "__main__":
    main()
