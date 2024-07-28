from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "article")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct",
        choices=["correct", "polish", "draw", "polish_long", "draw_long", "polish_multiple"],
    )
    args = parser.parse_args()

    print(f"{colored('args:', 'blue')} {args}")
    print(f"{colored('Revising', 'green')} {args.input_file}...\n")

    task_prefix = args.task.split("_")[0]

    user_vars = coa.get_user_vars(args)
    if "multiple" in args.task:
        coa.update_user_vars_multiple_output(args, user_vars)
    else:
        coa.update_user_vars_single_output(args, user_vars)

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)
    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, prompt_dict)

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file

    use_scratchpad = "<scratchpad>" in output_settings["prefill_first"]
    use_scratchpad_reflect = "<scratchpad>" in output_settings["prefill_reflect"]

    file_extension = "xml" if use_scratchpad else output_type
    initial_output_file = coa.get_output_file_name(base_output_file, task_prefix, model, file_extension)

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

    if end_turn and output_type == "tex":
        if use_scratchpad:
            coa.ensure_correct_xml_structure(initial_output_file, task_settings["document_tag"])
            output_files = coa.split_scratchpad_output_xml(initial_output_file, task_settings["document_tag"])

            if isinstance(output_files, list):  # Multiple output files
                for input_file, output_file in zip(args.output_files, output_files):
                    coa.log_output_files(output_file, log_file)
                    if output_type == "tex":
                        coa.run_latexdiff(input_file, output_file, args.task)
            else:  # Single output file
                output_file = output_files
                if output_type == "tex":
                    coa.run_latexdiff(args.input_file, output_file, args.task)
        else:
            output_file = initial_output_file
            if output_type == "tex":
                coa.run_latexdiff(args.input_file, output_file, args.task)
            coa.log_output_files(output_file, log_file)

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if end_turn and args.reflect:
        if use_scratchpad_reflect:
            initial_output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, "xml", reflect=True)
        else:
            initial_output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, output_type, reflect=True)
        print(f"initial_output_file_reflect: {initial_output_file_reflect}")

        state, accumulated_output_reflect, end_turn_reflect, messages = coa.process_reflection_round(
            client,
            args.task,
            args.input_file,
            initial_output_file_reflect,
            state,
            messages,
            model_settings=model_settings,
            output_settings=output_settings,
            prompt_settings=prompt_settings,
        )
        if end_turn_reflect:
            output_file_reflect = initial_output_file_reflect
            if use_scratchpad_reflect:
                coa.ensure_correct_xml_structure(initial_output_file_reflect, task_settings["document_tag"])
                output_files_reflect = coa.split_scratchpad_output_xml(initial_output_file_reflect, task_settings["document_tag"])
                print(f"output_file_reflect: {output_file_reflect}")

                if isinstance(output_files_reflect, list):  # Multiple output files
                    for input_file, output_file, output_file_reflect in zip(args.output_files, output_files, output_files_reflect):
                        coa.log_output_files(output_file_reflect, log_file)
                        if output_type == "tex":
                            coa.run_latexdiff(input_file, output_file_reflect, args.task)
                            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)
                else:  # Single output file
                    output_file_reflect = output_files_reflect
                    if output_type == "tex":
                        coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
                        coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)
            else:
                output_file_reflect = initial_output_file_reflect
                coa.log_output_files(output_file_reflect, log_file)
                if output_type == "tex":
                    coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
                    coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

        coa.log_output_files(initial_output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
