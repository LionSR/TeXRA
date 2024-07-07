from termcolor import colored
import coauthor as coa

all_tasks_settings = {
    "correct_prl": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "Now we output the corrected supp.tex as follows.\n<latex_document>",
    },
    "correct_supp_prl": {
        "document_tag": "latex_document",
        "output_type": "tex",
        "end_tag": "</latex_document>",
        "prefill_first": "Now we output the corrected supp.tex as follows.\n<latex_document>",
    },
}

prompt_path = coa.get_prompt_path(coa, "prl_edit")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--auxiliary_files", type=str, help="Path to the auxiliary TeX file to be processed.")
    parser.add_argument(
        "--task",
        type=str,
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars["PREAMBLE_CONTENT"] = coa.read_file("preamble.tex")

    if args.task == "correct_prl":
        user_prefix_vars["SUPP_CONTENT"] = coa.read_file("supp.tex")
    elif args.task == "correct_supp_prl":
        user_prefix_vars["main_content"] = coa.read_file(args.auxiliary_files)

    task_settings = all_tasks_settings[args.task]

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    log_file_path = coa.log_start(args)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = coa.process_first_round(
        coa.get_model_client(model_settings["model"]),
        args.task,
        args.input_file,
        user_prefix_vars,
        model_settings,
        output_settings,
        prompt_settings,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn:
        coa.run_latexdiff(args.input_file, output_file)

    coa.log_output_files(output_file, log_file_path)
    coa.log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = coa.process_reflection_round(
            coa.get_model_client(model_settings["model"]),
            args.task,
            args.input_file,
            state,
            messages,
            model_settings,
            output_settings,
            prompt_settings,
            use_prefill_from_input=False,
        )
        coa.log_output_files(output_file_reflect, log_file_path)
        coa.log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect:
            coa.run_latexdiff(args.input_file, output_file_reflect)
            coa.run_latexdiff(output_file, output_file_reflect, args.model)


if __name__ == "__main__":
    main()
