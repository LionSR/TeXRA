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

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    output_file = coa.get_output_file_name(args.input_file, args.task, model, output_type)

    state, accumulated_output, end_turn, messages, model_settings, output_settings, prompt_settings = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        output_file,
        user_prefix_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
        figure_inputs=args.figure_inputs,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn:
        coa.run_latexdiff(args.input_file, output_file, args.task)

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if args.reflect and end_turn:
        output_file_reflect = coa.get_output_file_name(args.input_file, args.task, model, output_type, reflect=True)

        state, accumulated_output_reflect, end_turn_reflect, messages = coa.process_reflection_round(
            client,
            args.task,
            args.input_file,
            output_file_reflect,
            state,
            messages,
            model_settings=model_settings,
            output_settings=output_settings,
            prompt_settings=prompt_settings,
        )
        coa.log_output_files(output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)
        if end_turn_reflect:
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
