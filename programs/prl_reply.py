from termcolor import colored
import coauthor
from coauthor import get_common_argparser, get_prompt_path
from coauthor.process import process_file_with_llm
from coauthor.edit_utils import (
    get_user_prefix_vars,
    handle_long_task,
    handle_reflection,
    get_llm_settings,
    get_output_settings,
)
from coauthor.log_utils import log_start, log_and_print_summary, log_output_files


all_tasks_settings = {
    "reply_letter": {
        "document_tag": "latex_document",
        "end_tag": "</reply_letter>",
        "output_type": "txt",
        "first_prefill": "<reply_letter>\n<cover_letter>",
    },
    "revise_main": {
        "document_tag": "latex_document",
        "end_tag": "</revised_main>",
        "output_type": "tex",
        "first_prefill": "Now output the revised main paper.\n <revised_main>",
    },
    "revise_supp": {
        "document_tag": "latex_document",
        "end_tag": "</revise_supp>",
        "output_type": "tex",
        "first_prefill": "Now output the revised supplementary material.\n <revise_supp>",
    },
    "polish_reply": {
        "document_tag": "latex_document",
        "end_tag": "</reply_letter>",
        "output_type": "txt",
        "first_prefill": "Now output the polished reply letter.\n <reply_letter>",
    },
}

prompt_path = get_prompt_path(coauthor, "prl_reply")


def main():
    parser = get_common_argparser()
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file to be included in the response.", default=None)
    parser.add_argument("--supp_file", type=str, help="Path to the supplementary TeX file to be included in the response.", default=None)
    parser.add_argument("--instruction", type=str, help="Path to the file containing the overall instruction.")
    parser.add_argument(
        "--task", type=str, default="reply_letter", help="Mode of operation.", choices=["reply_letter", "revise_main", "revise_supp", "polish_reply"]
    )
    parser.add_argument("--cover_letter", type=str, help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, help="Path to the editor letter file.")
    parser.add_argument("--report_a", type=str, help="Path to the referee report A file.")
    parser.add_argument("--report_b", type=str, help="Path to the referee report B file.")
    parser.add_argument("--preamble", type=str, default="preamble.tex", help="Path to the preamble file.")
    parser.add_argument("--example_reply_letter", type=str, default="rebuttal_example/reply_letter.txt", help="Path to the example reply letter file.")
    parser.add_argument("--draft_reply_letter", type=str, help="Path to the draft reply letter file.")
    parser.add_argument("--draft_main_content", type=str, help="Path to the draft main content file.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Preparing response for {args.input_file}...\n", "green"))

    user_prefix_vars = get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "PREAMBLE_CONTENT": coauthor.read_file(args.preamble),
            "MAIN_CONTENT": coauthor.read_file(args.input_file),
            "SUPP_CONTENT": coauthor.read_file(args.supp_file) if args.supp_file else "",
            "INSTRUCTION": coauthor.read_file(args.instruction) if args.instruction else "",
            "COVER_LETTER": coauthor.read_file(args.cover_letter) if args.cover_letter else "",
            "EDITOR_DECISION_LETTER": coauthor.read_file(args.editor_letter) if args.editor_letter else "",
            "REFEREE_REPORT_A": coauthor.read_file(args.report_a) if args.report_a else "",
            "REFEREE_REPORT_B": coauthor.read_file(args.report_b) if args.report_b else "",
            "EXAMPLE_REPLY_LETTER": coauthor.read_file(args.example_reply_letter) if args.example_reply_letter else "",
        }
    )

    task_settings = all_tasks_settings[args.task]

    if "revise" in args.task or "polish" in args.task:
        user_prefix_vars["DRAFT_REPLY_LETTER"] = coauthor.read_file(args.draft_reply_letter) if args.draft_reply_letter else ""

    if "polish" in args.task:
        user_prefix_vars["MAIN_CONTENT"] = coauthor.read_file(args.main_content) if args.main_content else ""

    if args.task == "revise_supp":
        user_prefix_vars["SUPP_CONTENT"] = coauthor.read_file(args.input_file)
        user_prefix_vars["MAIN_CONTENT"] = coauthor.read_file(args.main_content) if args.main_content else ""
        user_prefix_vars["DRAFT_MAIN_CONTENT"] = coauthor.read_file(args.draft_main_content) if args.draft_main_content else ""

    log_file_path = log_start(args)

    llm_settings = get_llm_settings(args, prompt_path)
    output_settings = get_output_settings(args, task_settings)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings = process_file_with_llm(
        args.task, task_settings, args.input_file, user_prefix_vars, llm_settings, output_settings
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    coauthor.run_latexdiff(args.input_file, output_file)

    log_output_files(log_file_path, output_file)
    log_and_print_summary(state, args.model, log_file_path)

    if args.reflect and end_turn:
        handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path)


if __name__ == "__main__":
    main()
