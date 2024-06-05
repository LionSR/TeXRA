import os
from termcolor import colored

import coauthor
from coauthor import read_file, get_common_argparser, get_prompt_path

all_tasks_settings = {
    "paper2note": {
        "document_tag": "latex_document",
        "end_tag": "</lecture_note>",
        "output_type": "tex",
        "first_prefill": "Here is the output lecture note <lecture_note>.\n\\documentclass{lecture}\n\\input{command}\n\\course",
    },
}

prompt_path = get_prompt_path(coauthor, "paper2note")


def main():
    parser = get_common_argparser()

    parser.add_argument(
        "--sample_chapters",
        type=str,
        nargs="+",
        help="Paths to the sample chapter TeX files.",
    )
    parser.add_argument(
        "--sample_paper",
        type=str,
        help="Path to the sample research paper TeX file.",
    )
    parser.add_argument(
        "--sample_note",
        type=str,
        help="Path to the sample lecture note TeX file corresponding to the sample paper.",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="paper2note",
        help="Task to perform, currently only 'paper2note'.",
        choices=["paper2note"],
    )

    args = parser.parse_args()
    print(colored(f"args: {args}", "blue"))

    print(colored(f"Preparing lecture notes for {args.input_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "SAMPLE_CHAPTERS": "\n".join([read_file(ch) for ch in args.sample_chapters]),
        "SAMPLE_PAPER": read_file(args.sample_paper),
        "SAMPLE_NOTE": read_file(args.sample_note),
        "DOCUMENT_CLS_CONTENT": read_file("lecture.cls"),
        "COMMANDS_CONTENT": read_file("command.tex"),
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
