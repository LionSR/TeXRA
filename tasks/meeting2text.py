from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "meeting2text")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--context_file", type=str, required=True, help="Path to the file containing the context for the discussion transcript.")
    parser.add_argument("--example_transcript", type=str, default=None, help="Path to the example transcript file.")
    parser.add_argument("--example_edited_transcript", type=str, default=None, help="Path to the example edited transcript file.")
    parser.add_argument("--task", type=str, default="transcribe", help="Task to perform, currently only 'transcribe'.", choices=["transcribe"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Transcribing {args.input_file}...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "TRANSCRIPT": coa.read_file(args.input_file),
            "CONTEXT": coa.read_file(args.context_file),
            "EXAMPLE_TRANSCRIPT": coa.read_file(args.example_transcript),
            "EXAMPLE_EDITED_TRANSCRIPT": coa.read_file(args.example_edited_transcript),
        }
    )

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task, prompt_dict)

    coa.handle_single_output(args, user_prefix_vars)

    client = coa.get_model_client(model_settings["model"])

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file
    output_file = coa.get_output_file_name(base_output_file, args.task, model, output_type)

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

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
