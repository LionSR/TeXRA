from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "merge")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--task", type=str, default="merge", help="Task to perform.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Merging {args.input_file} and {args.edited_file}...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_prefix_vars = {
        "INPUT_FILE": args.input_file,
        "ORIGINAL_LATEX": coa.read_file(args.input_file),
        "EDITED_LATEX": coa.read_file(args.edited_file),
    }

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task, prompt_dict)

    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    coa.handle_single_output(args, user_prefix_vars)

    client = coa.get_model_client(model_settings["model"])

    output_file = coa.get_output_file_name_merge(args.input_file, args.edited_file)

    state, accumulated_output, end_turn, messages = coa.process_first_round(
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
    if end_turn:
        if output_type == "tex":
            coa.run_latexdiff(args.input_file, output_file, args.task, args.model)

    print(colored(f"Output file: {output_file}", "yellow"))

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
