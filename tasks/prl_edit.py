from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl_edit")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--preamble_file", default="preamble.tex", type=str, help="Path to the preamble TeX file.")
    parser.add_argument("--auxiliary_files", type=str, help="Path to the auxiliary TeX file to be processed.")
    parser.add_argument("--supp_file", type=str, default="supp.tex", help="Path to the supplementary TeX file to be processed.")
    parser.add_argument(
        "--task",
        type=str,
        default="correct_prl",
        help="Mode of operation, either 'correct_prl', 'correct_supp_prl'.",
        choices=["correct_prl", "correct_supp_prl"],
    )
    args = parser.parse_args()

    print(f"{colored('args:', 'blue')} {args}")
    print(f"{colored('Revising', 'green')} {args.input_file}...\n")

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_vars = coa.get_user_vars(args)
    user_vars["PREAMBLE_FILE"] = args.preamble_file
    user_vars["PREAMBLE_CONTENT"] = coa.read_file(args.preamble_file)

    if args.task == "correct_prl":
        user_vars["SUPP_FILE"] = args.supp_file
        user_vars["SUPP_CONTENT"] = coa.read_file(args.supp_file)
    elif args.task == "correct_supp_prl":
        user_vars["MAIN_FILE"] = args.auxiliary_files
        user_vars["MAIN_CONTENT"] = coa.read_file(args.auxiliary_files)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, prompt_dict)

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file
    output_file = coa.get_output_file_name(base_output_file, args.task, model, output_type)

    state, accumulated_output, end_turn, messages = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        output_file,
        user_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
        figure_inputs=args.figure_inputs,
    )

    print(colored(f"Output file: {output_file}", "yellow"))

    if end_turn:
        if output_type == "tex":
            coa.run_latexdiff(args.input_file, output_file, args.task)

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if end_turn and args.reflect:
        output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, output_type, reflect=True)

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
            if output_type == "tex":
                coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
                coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
