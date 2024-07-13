from termcolor import colored
import coauthor as coa

# Define the settings for each mode
all_tasks_settings = {
    "adapt": {
        "document_tag": "latex_document",
        "end_tag": "\\end{document}",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
    },
}

prompt_path = coa.get_prompt_path(coa, "adapt")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, default="lecture.cls", help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, default="command.tex", help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="adapt", choices=["adapt"], help="Mode of operation, either 'adapt'.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "EXISTING_LECTURE_NOTES": coa.read_file(args.sample_tex),
            "DOCUMENT_CLS_CONTENT": coa.read_file(args.document_cls),
            "COMMANDS_CONTENT": coa.read_file(args.commands_file),
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    coa.handle_single_input(args, user_prefix_vars, prompt_settings)

    client = coa.get_model_client(model_settings["model"])

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
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn:
        coa.split_scratchpad_output(output_file)
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
            coa.split_scratchpad_output(output_file_reflect)
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)


if __name__ == "__main__":
    main()
