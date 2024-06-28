def get_model_settings(args):
    figure_inputs = args.figure_inputs
    if isinstance(figure_inputs, str):
        figure_inputs = figure_inputs.split(",")
    elif not isinstance(figure_inputs, list):
        figure_inputs = None

    return {
        "model": args.model,
        "api_key": None,
        "figure_inputs": figure_inputs,
        "max_tokens": 4096,
        "temperature": 0,
    }


def get_output_settings(args, task_settings):
    return {
        "first_prefill": task_settings.get("first_prefill"),
        "first_prefill_reflect": task_settings.get("first_prefill_reflect"),
        "use_prefill_from_input": False,
        "k": 200,
        "append_mode": args.append_mode,
        "overwrite": False,
        "document_tag": task_settings.get("document_tag"),
        "output_type": task_settings.get("output_type", "txt"),
        "end_tag": task_settings.get("end_tag", "\\end{document}"),
    }


def get_prompt_settings(prompt_path, task_settings, task):
    prompt_settings = {}

    prompt_settings.setdefault("prompt_path", prompt_path)
    prompt_settings.setdefault("system_prompt_file", f"system_prompt_{task}.txt")
    prompt_settings.setdefault("user_prefix_file", f"user_prefix_{task}.txt")
    prompt_settings.setdefault("user_request_file", f"user_request_{task}.txt")
    prompt_settings.setdefault("user_reflect_file", f"user_reflect_{task}.txt")
    prompt_settings.setdefault("first_prefill", task_settings.get("first_prefill"))
    prompt_settings.setdefault("first_prefill_reflect", task_settings.get("first_prefill_reflect"))

    for key, value in task_settings.items():
        if key in ["prompt_path", "system_prompt_file", "user_prefix_file", "user_request_file", "user_reflect_file"]:
            prompt_settings.update({key: value})

    return prompt_settings
