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
    "write": {
        "document_tag": "cover_letter",
        "end_tag": "</cover_letter>",
        "output_type": "tex",
        "prefill_first": "<scratchpad>",
        "system_prompt_file": "system_prompt_write.txt",
        "user_prefix_file": "user_prefix_write.txt",
        "user_request_file": "user_request_write.txt",
        "user_reflect_file": "user_reflect_write.txt",
    },
}


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="correct", choices=["correct", "polish", "draw", "polish_long", "draw_long", "write"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Revising {args.input_file}...\n", "green"))

    task_shared = args.task.split("_")[0]

    user_prefix_vars = coa.get_user_prefix_vars(args)

    task_settings = all_task_settings[task_shared]

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, task_shared)

    if "long" in args.task:
        coa.handle_long_input(args, user_prefix_vars, prompt_settings)
    else:
        coa.handle_single_input(args, user_prefix_vars, prompt_settings)

    client = coa.get_model_client(model_settings["model"])

    log_file_path = coa.log_start(args)
    state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings = coa.process_first_round(
        client,
        args.task,
        args.input_file,
        user_prefix_vars,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
    )
    if end_turn and task_settings["output_type"] == "txt":
        coa.run_latexdiff(args.input_file, output_file, args.task)

    coa.log_output_files(output_file, log_file_path)
    coa.log_and_print_statistics(state, args.model, log_file_path)

    if args.reflect and end_turn:
        state, accumulated_output_reflect, end_turn_reflect, output_file_reflect, messages = coa.process_reflection_round(
            client,
            args.task,
            args.input_file,
            state,
            messages,
            model_settings=model_settings,
            output_settings=output_settings,
            prompt_settings=prompt_settings,
        )
        coa.log_output_files(output_file_reflect, log_file_path)
        coa.log_and_print_statistics(state, args.model, log_file_path)
        if end_turn_reflect and task_settings["output_type"] == "txt":
            coa.run_latexdiff(args.input_file, output_file_reflect, args.task)
            coa.run_latexdiff(output_file, output_file_reflect, args.model)


if __name__ == "__main__":
    main()
