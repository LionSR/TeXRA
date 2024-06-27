def get_llm_settings(args, prompt_path):
    figure_inputs = args.figure_inputs
    if isinstance(figure_inputs, str):
        figure_inputs = figure_inputs.split(",")
    elif not isinstance(figure_inputs, list):
        figure_inputs = None

    return {
        "model": args.model,
        "api_key": None,
        "prompt_path": prompt_path,
        "figure_inputs": figure_inputs,
        "max_tokens": 4096,
        "temperature": 0,
    }


def get_output_settings(args, task_settings):
    return {
        "use_prefill_from_input": False,
        "append_mode": args.append_mode,
        "overwrite": False,
        "k": 200,
        "document_tag": task_settings.get("document_tag"),
        "output_type": task_settings.get("output_type", "txt"),
    }
