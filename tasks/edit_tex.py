from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "article")

all_task_settings = {
    "correct": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "Here is the revised latex document. <latex_document>",
        "system_prompt_file": "system_prompt_correct.txt",
        "user_prefix_file": "user_prefix_correct.txt",
        "user_request_file": "user_request_correct.txt",
        "user_reflect_file": "user_reflect_correct.txt",
    },
    "polish": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish.txt",
        "user_request_file": "user_request_polish.txt",
        "user_reflect_file": "user_reflect_polish.txt",
    },
    "draw": {
        "document_tag": "latex_document",
        "end_tag": "</latex_document>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_draw.txt",
        "user_prefix_file": "user_prefix_draw.txt",
        "user_request_file": "user_request_draw.txt",
        "user_reflect_file": "user_reflect_draw.txt",
    },
    "polish_multiple": {
        "document_tag": "latex_documents",
        "end_tag": "</latex_documents>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_polish.txt",
        "user_prefix_file": "user_prefix_polish_multiple.txt",
        "user_request_file": "user_request_polish_multiple.txt",
        "user_reflect_file": "user_reflect_polish_multiple.txt",
    },
}


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="correct", choices=["correct", "polish", "draw", "polish_long", "draw_long", "polish_multiple"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]

    user_prefix_vars = coa.get_user_prefix_vars(args)

    task_settings = all_task_settings[task_shared]
    if args.task == "polish_multiple":
        task_settings = all_task_settings["polish_multiple"]

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, task_shared)

    if args.task == "polish_multiple":
        handle_multiple_input(args, user_prefix_vars, prompt_settings)
    elif "long" in args.task:
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

        if task_settings["prefill_first"] == "<scratchpad>" and output_type == "tex":
            coa.ensure_correct_xml_structure(initial_output_file_reflect, task_settings["document_tag"])
            output_file_reflect = coa.split_scratchpad_output(initial_output_file_reflect, task_settings["document_tag"])
            # output_file_reflect = coa.split_scratchpad_output_xml(initial_output_file_reflect, task_settings["document_tag"])

        if end_turn_reflect and task_settings["output_type"] == "tex":
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)
        else:
            output_file_reflect = initial_output_file_reflect

        coa.log_output_files(initial_output_file_reflect, log_file)
        coa.log_and_print_statistics(state, args.model, log_file)

    coa.log_end(log_file)


def handle_multiple_input(args, user_prefix_vars, prompt_settings):
    input_files = [args.input_file] + (args.input_files or [])
    if len(input_files) < 2:
        raise ValueError("At least two input files are required for polish_multiple task.")
    if not args.output_files or len(args.output_files) != len(input_files):
        raise ValueError("Number of output files must match the number of input files.")

    user_prefix_vars["ADDITIONAL_INPUT_FILES"] = ""
    for i, input_file in enumerate(input_files[1:], start=2):
        content = coa.read_file(input_file)
        user_prefix_vars[
            "ADDITIONAL_INPUT_FILES"
        ] += f"""
    <document index="{i}">
        <source>{input_file}</source>
        <document_content>
            {content}
        </document_content>
    </document>"""

    user_prefix_vars["OUTPUT_FILES_ORDER"] = ", ".join(args.output_files)

    # Handle auxiliary files
    if args.auxiliary_files:
        user_prefix_vars["AUXILIARY_FILE"] = args.auxiliary_files[0]
        user_prefix_vars["AUXILIARY_CONTENT"] = coa.read_file(args.auxiliary_files[0])
    else:
        user_prefix_vars["AUXILIARY_FILE"] = "No auxiliary file provided"
        user_prefix_vars["AUXILIARY_CONTENT"] = "No auxiliary content"

    # Update the user_prefix_file to use the multiple input version
    prompt_settings["user_prefix_file"] = prompt_settings["user_prefix_file"].replace("polish.txt", "polish_multiple.txt")

    # Ensure the first input file is correctly set in user_prefix_vars
    user_prefix_vars["INPUT_FILE"] = args.input_file
    user_prefix_vars["INPUT_CONTENT"] = coa.read_file(args.input_file)

    # Add AUXILIARY_FILE_CONTENT
    user_prefix_vars["AUXILIARY_FILE_CONTENT"] = (
        f"""
    <document index="0">
        <source>{user_prefix_vars['AUXILIARY_FILE']}</source>
        <document_content>
            {user_prefix_vars['AUXILIARY_CONTENT']}
        </document_content>
    </document>
"""
        if user_prefix_vars["AUXILIARY_FILE"] != "No auxiliary file provided"
        else ""
    )


if __name__ == "__main__":
    main()
