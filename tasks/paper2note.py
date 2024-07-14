from termcolor import colored
import coauthor as coa

# Define the settings for each mode
all_tasks_settings = {
    "paper2note": {
        "document_tag": "latex_document",
        "end_tag": "</lecture_note>",
        "output_type": "tex",
        "prefill_first": "Here is the output lecture note <lecture_note>.\n\\documentclass{lecture}\n\\input{command}\n\\course",
    },
}

prompt_path = coa.get_prompt_path(coa, "paper2note")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--sample_chapters", type=str, nargs="+", help="Paths to the sample chapter TeX files.")
    parser.add_argument("--sample_paper", type=str, help="Path to the sample research paper TeX file.")
    parser.add_argument("--sample_note", type=str, help="Path to the sample lecture note TeX file corresponding to the sample paper.")
    parser.add_argument("--task", type=str, default="paper2note", help="Task to perform, currently only 'paper2note'.", choices=["paper2note"])
    args = parser.parse_args()

    print(colored(f"args: {args}", "blue"))
    print(colored(f"Preparing lecture notes for {args.input_file}...\n", "green"))

    user_prefix_vars = coa.get_user_prefix_vars(args)
    user_prefix_vars.update(
        {
            "SAMPLE_CHAPTERS": "\n".join([coa.read_file(ch) for ch in args.sample_chapters]),
            "SAMPLE_PAPER": coa.read_file(args.sample_paper),
            "SAMPLE_NOTE": coa.read_file(args.sample_note),
            "DOCUMENT_CLS_CONTENT": coa.read_file("lecture.cls"),
            "COMMANDS_CONTENT": coa.read_file("command.tex"),
        }
    )

    task_settings = all_tasks_settings[args.task]

    log_file = coa.log_start(args)

    model_settings = coa.get_model_settings(args)
    output_settings = coa.get_output_settings(args, task_settings)
    prompt_settings = coa.get_prompt_settings(args, prompt_path, task_settings, args.task)

    model = model_settings["model"]
    output_type = output_settings["output_type"]

    client = coa.get_model_client(model_settings["model"])
    log_file = coa.log_start(args)

    output_file = coa.get_output_file_name(args.input_file, args.task, model, output_type)

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
        if end_turn_reflect and output_settings["output_type"] == "tex":
            coa.run_latexdiff(output_file, output_file_reflect, args.task, args.model)

    coa.log_end(log_file)


if __name__ == "__main__":
    main()
