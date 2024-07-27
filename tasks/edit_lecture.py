from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "lecture")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        choices=[
            "correct_qi",
            "correct_st",
            "polish_qi",
            "polish_st",
            "draw_st",
            "draw_qi",
            "polish_st_multiple",
            "draw_st_multiple",
            "correct_st_multiple",
        ],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]
    task_sub = f"{task_shared}_{args.task.split('_')[1]}"

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "DOCUMENT_CLS": "lecture.cls",
            "COMMANDS": "commands_qi.tex" if "qi" in args.task else "command.tex",
        }
    )
    user_prefix_vars.update(
        {
            "DOCUMENT_CLS_CONTENT": coa.read_file(user_prefix_vars["DOCUMENT_CLS"]),
            "COMMANDS_CONTENT": coa.read_file(user_prefix_vars["COMMANDS"]),
        }
    )

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)
    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, task_sub, prompt_dict)

    print(colored(f"prompt_settings: {prompt_settings}\n", "blue"))
    print(colored(f"output_settings: {output_settings}\n", "blue"))
    print(colored(f"model_settings: {model_settings}\n", "blue"))

    if "multiple" in args.task:
        coa.update_user_prefix_vars_multiple_output(args, user_prefix_vars)
    else:
        coa.update_user_prefix_vars_single_output(args, user_prefix_vars)

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file

    if prompt_settings["prefill_first"] == "<scratchpad>":
        initial_output_file = coa.get_output_file_name(base_output_file, task_shared, model, "xml")
    else:
        initial_output_file = coa.get_output_file_name(base_output_file, task_shared, model, output_type)

    state, accumulated_output, end_turn, messages = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        initial_output_file,
        user_prefix_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
        figure_inputs=args.figure_inputs,
    )

    if end_turn:
        if prompt_settings["prefill_first"] == "<scratchpad>":
            coa.ensure_correct_xml_structure(initial_output_file, task_settings["document_tag"])
            output_files = coa.split_scratchpad_output_xml(initial_output_file, task_settings["document_tag"])

            if isinstance(output_files, list):  # Multiple output files
                for output_file in output_files:
                    coa.log_output_files(output_file, log_file)
            else:  # Single output file
                output_file = output_files
                if output_type == "tex":
                    coa.run_latexdiff(args.input_file, output_file, args.task)
                coa.log_output_files(output_file, log_file)
        else:
            output_file = initial_output_file
            if output_type == "tex":
                coa.run_latexdiff(args.input_file, output_file, args.task)
            coa.log_output_files(output_file, log_file)

    coa.log_output_files(initial_output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if end_turn and args.reflect:
        if prompt_settings["prefill_reflect"] == "<scratchpad>":
            initial_output_file_reflect = coa.get_output_file_name(base_output_file, task_shared, model, "xml", reflect=True)
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
            # this logic needs to be fixed for the multiple output file logic
            if prompt_settings["prefill_reflect"] == "<scratchpad>":
                coa.ensure_correct_xml_structure(initial_output_file_reflect, task_settings["document_tag"])
                output_files_reflect = coa.split_scratchpad_output_xml(initial_output_file_reflect, task_settings["document_tag"])

                if isinstance(output_files_reflect, list):  # Multiple output files
                    for output_file_reflect in output_files_reflect:
                        coa.log_output_files(output_file_reflect, log_file)
                else:  # Single output file
                    output_file_reflect = output_files_reflect
                    coa.log_output_files(output_file_reflect, log_file)
            else:
                output_file_reflect = initial_output_file_reflect

            if isinstance(output_files_reflect, list):  # Multiple output files
                for output_file, output_file_reflect in zip(output_files, output_files_reflect):
                    if output_type == "tex":
                        coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)
                    coa.log_output_files(output_file_reflect, log_file)
            else:  # Single output file
                output_file_reflect = output_files_reflect
                if output_type == "tex":
                    coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
                    coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)
            
                coa.log_output_files(output_file_reflect, log_file)

        coa.log_output_files(initial_output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
