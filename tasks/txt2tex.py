from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "txt2tex")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="txt2tex", choices=["txt2tex"], help="Task to perform, currently only 'txt2tex'.")
    args = parser.parse_args()

    print(f"{colored('args:', 'blue')} {args}")
    print(colored(f"Converting {args.input_file} to LaTeX...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_vars = coa.get_user_vars(args)
    user_vars.update(
        {
            "EXISTING_LECTURE_NOTES": coa.read_file(args.sample_tex) if args.sample_tex else "",
            "DOCUMENT_CLS_CONTENT": coa.read_file(args.document_cls) if args.document_cls else "",
            "COMMANDS_CONTENT": coa.read_file(args.commands_file) if args.commands_file else "",
        }
    )

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
            coa.run_latexdiff(args.input_file, output_file, args.task, args.model)

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
                coa.run_latexdiff(args.input_file, output_file_reflect, args.task, args.model)
                coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
