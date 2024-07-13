from termcolor import colored
import coauthor as coa

all_tasks_settings = {
    "transcribe": {
        "document_tag": "improved_document",
        "end_tag": "</improved_document>",
        "output_type": "txt",
        "prefill_first": "Here is the faithfully and correctly improved document:\n<improved_document>",
    },
    "punctuate": {
        "document_tag": "improved_document",
        "end_tag": "</improved_document>",
        "output_type": "txt",
        "prefill_first": "Here is the faithfully and correctly improved document:\n<improved_document>",
    },
    "2tex": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "prefill_first": "\\documentclass{lecture}\n\\input{commands_qi}\n\\course{",
    },
    "reflect": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "prefill_first": "\\documentclass{lecture}\n\\input{commands_qi}",
    },
}

prompt_path = coa.get_prompt_path(coa, "lecture2text")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "DOCUMENT_CLS": "lecture.cls",
            "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
            "COMMANDS": "commands_qi.tex",
            "COMMANDS_CONTENT": coa.read_file("commands_qi.tex"),
        }
    )

    if args.task in ["2tex", "reflect"]:
        user_prefix_vars["INPUT_CONTENT"] = coa.extract_text_from_tags(coa.read_file(args.input_file), "improved_document")
    elif args.task in ["transcribe", "punctuate"]:
        user_prefix_vars["INPUT_CONTENT"] = coa.read_file(args.input_file)

    task_settings = all_tasks_settings[args.task]

    log_file_path = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    if "long" in args.task:
        coa.handle_long_input(args, user_prefix_vars, prompt_settings)
    else:
        coa.handle_single_input(args, user_prefix_vars, prompt_settings)

    client = coa.get_model_client(model_settings["model"])

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        user_prefix_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn and output_settings["output_type"] == "tex":
        coa.split_scratchpad_output(output_file)
        coa.run_latexdiff(args.input_file, output_file, args.task)

    coa.log_output_files(output_file, log_file_path)
    coa.log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = coa.process_reflection_round(
            client,
            args.task,
            args.input_file,
            state,
            messages,
            model_settings=model_settings,
            output_settings=output_settings,
            prompt_settings=prompt_settings,
            use_prefill_from_input=False,
        )
        coa.log_output_files(output_file_reflect, log_file_path)
        coa.log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect and output_settings["output_type"] == "tex":
            coa.split_scratchpad_output(output_file_reflect)
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)


if __name__ == "__main__":
    main()
