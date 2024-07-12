from termcolor import colored
import coauthor as coa

all_tasks_settings = {
    "txt2tex": {
        "document_tag": "txt_content",
        "end_tag": "</latex_content>",
        "output_type": "tex",
        "prefill_first": "<latex_content> \\chapter",
    },
}

prompt_path = coa.get_prompt_path(coa, "txt2tex")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_tex", type=str, help="Path to a sample LaTeX file in the desired style.")
    parser.add_argument("--document_cls", type=str, help="Path to the document class file.")
    parser.add_argument("--commands_file", type=str, help="Path to the file containing custom LaTeX commands.")
    parser.add_argument("--task", type=str, default="txt2tex", choices=["txt2tex"], help="Task to perform, currently only 'txt2tex'.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Converting {args.input_file} to LaTeX...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "EXISTING_LECTURE_NOTES": coa.read_file(args.sample_tex) if args.sample_tex else "",
            "DOCUMENT_CLS_CONTENT": coa.read_file(args.document_cls) if args.document_cls else "",
            "COMMANDS_CONTENT": coa.read_file(args.commands_file) if args.commands_file else "",
        }
    )

    task_settings = all_tasks_settings[args.task]

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    log_file_path = coa.log_start(args)

    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = coa.process_first_round(
        coa.get_model_client(model_settings["model"]),
        args.task,
        args.input_file,
        user_prefix_vars,
        model_settings,
        output_settings,
        prompt_settings,
    )

    print(colored(f"Output file: {output_file}", "yellow"))
    if end_turn and output_settings["output_type"] == "tex":
        coa.run_latexdiff(args.input_file, output_file, args.task)

    coa.log_output_files(output_file, log_file_path)
    coa.log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = coa.process_reflection_round(
            coa.get_model_client(model_settings["model"]),
            args.task,
            args.input_file,
            state,
            messages,
            model_settings,
            output_settings,
            prompt_settings,
            use_prefill_from_input=False,
        )
        coa.log_output_files(output_file_reflect, log_file_path)
        coa.log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect and output_settings["output_type"] == "tex":
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)


if __name__ == "__main__":
    main()
