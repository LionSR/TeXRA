from termcolor import colored
import coauthor as coa

# Define the settings for each mode
all_tasks_settings = {
    "merge": {
        "document_tag": "full_edited_latex",
        "end_tag": "</full_edited_latex>",
        "output_type": "tex",
        "prefill_first": "<full_edited_latex>",
    },
}

prompt_path = coa.get_prompt_path(coa, "merge")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--edited_file", type=str, help="Path to the edited LaTeX document.")
    parser.add_argument("--task", type=str, default="merge", help="Task to perform.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Merging {args.input_file} and {args.edited_file}...\n", "green"))

    user_prefix_vars = {
        "INPUT_FILE": args.input_file,
        "ORIGINAL_LATEX": coa.read_file(args.input_file),
        "EDITED_LATEX": coa.read_file(args.edited_file),
    }

    task_settings = all_tasks_settings[args.task]

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    coa.handle_single_input(args, user_prefix_vars, prompt_settings)

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

    print(colored(f"Output file: {output_file}", "yellow"))

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
