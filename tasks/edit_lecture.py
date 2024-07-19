from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "lecture")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "Here is the revised latex document. <latex_document>",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
}


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="correct_qi",
        choices=["correct_qi", "correct_st", "polish_qi", "polish_st", "draw_st", "draw_qi", "polish_st_long", "draw_st_long", "correct_st_long"],
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

    task_settings = all_task_settings[task_shared]
    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, task_sub)

    if "long" in args.task:
        coa.handle_long_input(args, user_prefix_vars, prompt_settings)
    else:
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
        output_file = coa.split_scratchpad_output(initial_output_file, task_settings["document_tag"])
        # output_file = coa.split_scratchpad_output_xml(initial_output_file, task_settings["document_tag"])
        coa.run_latexdiff(args.input_file, output_file, args.task)
    else:
        output_file = initial_output_file

    coa.log_output_files(output_file, log_file)
    coa.log_and_print_statistics(state, args.model, log_file)

    if args.reflect and end_turn:
        if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
            initial_output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, "text", reflect=True)
        else:
            initial_output_file_reflect = coa.get_output_file_name(base_output_file, args.task, model, output_type, reflect=True)

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

        # Ensure correct XML structure in the reflection output file
        if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
            coa.ensure_correct_xml_structure(initial_output_file_reflect, task_settings["document_tag"])

        coa.log_output_files(initial_output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

        if end_turn_reflect and task_settings["output_type"] == "tex":
            output_file_reflect = coa.split_scratchpad_output(initial_output_file_reflect, task_settings["document_tag"])
            # output_file_reflect = coa.split_scratchpad_output_xml(initial_output_file_reflect, task_settings["document_tag"])
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
