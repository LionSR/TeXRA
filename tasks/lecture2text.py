from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "lecture2text")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Processing {args.input_file} with task: {args.task}...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "DOCUMENT_CLS": "lecture.cls",
            "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
            "COMMANDS": "commands_qi.tex",
            "COMMANDS_CONTENT": coa.read_file("commands_qi.tex"),
        }
    )
    if args.task in ["2tex", "reflect"]:
        user_prefix_vars["INPUT_CONTENT"] = coa.extract_text_from_tags(coa.read_file(args.input_file), "improved_document")
        user_prefix_vars.update(
            {
                "corrected_transcription_content": coa.extract_text_from_tags(coa.read_file(args.input_file), "improved_document"),
                "converted_tex_file": args.input_file.replace(".txt", ".tex"),
                "converted_tex_content": coa.read_file(args.input_file.replace(".txt", ".tex")),
            }
        )
    elif args.task in ["transcribe", "punctuate"]:
        user_prefix_vars["INPUT_CONTENT"] = coa.read_file(args.input_file)

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task, prompt_dict)

    coa.update_user_prefix_vars_single_output(args, user_prefix_vars)

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
    if end_turn:
        if prompt_settings["prefill_first"] == "<scratchpad>":
            coa.split_scratchpad_output_xml(output_file, task_settings["document_tag"])
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
            if prompt_settings["prefill_first"] == "<scratchpad>":
                coa.split_scratchpad_output_xml(output_file_reflect, task_settings["document_tag"])

            if output_type == "tex":
                coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
                coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
