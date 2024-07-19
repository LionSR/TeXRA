from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "write")

all_task_settings = {
    "cover": {
        "document_tag": "cover_letter",
        "end_tag": "</cover_letter>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_cover.txt",
        "user_prefix_file": "user_prefix_cover.txt",
        "user_request_file": "user_request_cover.txt",
        "user_reflect_file": "user_reflect_cover.txt",
    },
    "proposal": {
        "document_tag": "research_proposal",
        "end_tag": "</research_proposal>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_proposal.txt",
        "user_prefix_file": "user_prefix_proposal.txt",
        "user_request_file": "user_request_proposal.txt",
        "user_reflect_file": "user_reflect_proposal.txt",
    },
}


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="cover", choices=["cover", "proposal"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Writing {args.task} for {args.input_file}...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    if args.sample_files:
        user_prefix_vars["REFERENCE_CONTENT"] = "\n".join([coa.read_file(sample) for sample in args.sample_files])
    else:
        user_prefix_vars["REFERENCE_CONTENT"] = ""

    task_settings = all_task_settings[args.task]

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    coa.handle_single_input(args, user_prefix_vars, prompt_settings)

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    base_output_file = args.output_name_override if args.output_name_override else args.input_file

    # Modify this part to output to .text first if conditions are met
    if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
        initial_output_file = coa.get_output_file_name(base_output_file, args.task, model, "text")
    else:
        initial_output_file = coa.get_output_file_name(base_output_file, args.task, model, output_type)

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

    # Ensure correct XML structure in the output file
    if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
        coa.ensure_correct_xml_structure(initial_output_file, task_settings["document_tag"])

    if end_turn and task_settings["output_type"] == "tex":
        # output_file = coa.split_scratchpad_output_xml(initial_output_file, task_settings["document_tag"])
        output_file = coa.split_scratchpad_output(initial_output_file, task_settings["document_tag"])
    else:
        output_file = initial_output_file

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if args.reflect and end_turn:
        if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
            output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, "text", reflect=True)
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
        if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
            coa.ensure_correct_xml_structure(output_file_reflect, task_settings["document_tag"])

        coa.log_output_files(output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

        if end_turn_reflect and task_settings["output_type"] == "tex":
            # output_file_reflect = coa.split_scratchpad_output_xml(output_file_reflect, task_settings["document_tag"])
            output_file_reflect = coa.split_scratchpad_output(output_file_reflect, task_settings["document_tag"])
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
