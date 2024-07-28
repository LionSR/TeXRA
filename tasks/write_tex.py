from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "write")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="paper2cover", choices=["paper2cover", "proposal", "slide2paper", "paper2slide"])
    args = parser.parse_args()

    print(f"{colored('args:', 'blue')} {args}")
    print(colored(f"Writing {args.task} for {args.input_file}...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_vars = coa.get_user_vars(args)

    # this handling of sample_files is problematic
    if args.sample_files:
        user_vars["REFERENCE_CONTENT"] = "\n".join([coa.read_file(sample) for sample in args.sample_files])
    else:
        user_vars["REFERENCE_CONTENT"] = ""

    coa.update_user_vars_single_output(args, user_vars)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, prompt_dict)

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    use_scratchpad = "<scratchpad>" in output_settings["prefill_first"]
    use_scratchpad_reflect = "<scratchpad>" in output_settings["prefill_reflect"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file

    file_extension = "xml" if use_scratchpad else output_type
    initial_output_file = coa.get_output_file_name(base_output_file, args.task, model, file_extension)

    state, accumulated_output, end_turn, messages = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        initial_output_file,
        user_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
        figure_inputs=args.figure_inputs,
    )

    output_file = initial_output_file

    # Ensure correct XML structure in the output file
    if end_turn:
        if use_scratchpad:
            coa.ensure_correct_xml_structure(initial_output_file, task_settings["document_tag"])
            output_file = coa.split_scratchpad_output_xml(initial_output_file, task_settings["document_tag"])

        if output_type == "tex":
            coa.run_latexdiff(args.input_file, output_file, args.task, args.model)

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if end_turn and args.reflect:
        if use_scratchpad_reflect:
            output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, "xml", reflect=True)
        else:
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

        # Ensure correct XML structure in the reflection output file
        if end_turn_reflect:
            if use_scratchpad_reflect:
                coa.ensure_correct_xml_structure(output_file_reflect, task_settings["document_tag"])
                output_file_reflect = coa.split_scratchpad_output_xml(output_file_reflect, task_settings["document_tag"])

            if output_type == "tex":
                coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

        coa.log_output_files(output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
