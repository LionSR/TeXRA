from termcolor import colored
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "prl_reply")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--main_content", type=str, help="Path to the main content TeX file to be included in the response.", default=None)
    parser.add_argument("--supp_file", type=str, help="Path to the supplementary TeX file to be included in the response.", default=None)
    parser.add_argument("--instruction", type=str, help="Path to the file containing the overall instruction.")
    parser.add_argument(
        "--task", type=str, default="reply_letter", help="Mode of operation.", choices=["reply_letter", "revise_main", "revise_supp", "polish_reply"]
    )
    parser.add_argument("--cover_letter", type=str, help="Path to the cover letter file.")
    parser.add_argument("--editor_letter", type=str, help="Path to the editor letter file.")
    parser.add_argument("--report_a", type=str, help="Path to the referee report A file.")
    parser.add_argument("--report_b", type=str, help="Path to the referee report B file.")
    parser.add_argument("--preamble", type=str, default="preamble.tex", help="Path to the preamble file.")
    parser.add_argument("--example_reply_letter", type=str, default="rebuttal_example/reply_letter.txt", help="Path to the example reply letter file.")
    parser.add_argument("--draft_reply_letter", type=str, help="Path to the draft reply letter file.")
    parser.add_argument("--draft_main_content", type=str, help="Path to the draft main content file.")
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Preparing response for {args.input_file}...\n", "green"))

    task_settings, prompt_dict = coa.load_task_settings_and_prompts(prompt_path, args.task)

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "PREAMBLE_CONTENT": coa.read_file(args.preamble),
            "MAIN_CONTENT": coa.read_file(args.input_file),
            "SUPP_CONTENT": coa.read_file(args.supp_file) if args.supp_file else "",
            "INSTRUCTION": coa.read_file(args.instruction) if args.instruction else "",
            "COVER_LETTER": coa.read_file(args.cover_letter) if args.cover_letter else "",
            "EDITOR_DECISION_LETTER": coa.read_file(args.editor_letter) if args.editor_letter else "",
            "REFEREE_REPORT_A": coa.read_file(args.report_a) if args.report_a else "",
            "REFEREE_REPORT_B": coa.read_file(args.report_b) if args.report_b else "",
            "EXAMPLE_REPLY_LETTER": coa.read_file(args.example_reply_letter) if args.example_reply_letter else "",
        }
    )

    if "revise" in args.task or "polish" in args.task:
        user_prefix_vars["DRAFT_REPLY_LETTER"] = coa.read_file(args.draft_reply_letter) if args.draft_reply_letter else ""

    if "polish" in args.task:
        user_prefix_vars["MAIN_CONTENT"] = coa.read_file(args.main_content) if args.main_content else ""

    if args.task == "revise_supp":
        user_prefix_vars["SUPP_CONTENT"] = coa.read_file(args.input_file)
        user_prefix_vars["MAIN_CONTENT"] = coa.read_file(args.main_content) if args.main_content else ""
        user_prefix_vars["DRAFT_MAIN_CONTENT"] = coa.read_file(args.draft_main_content) if args.draft_main_content else ""

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task, prompt_dict)

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
        if output_type == "tex":
            coa.run_latexdiff(args.input_file, output_file)

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
            if output_type == "tex":
                coa.run_latexdiff(args.input_file, output_file_reflect)
                coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
