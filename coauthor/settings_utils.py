from termcolor import colored
from .model_utils import model_mapping


def get_model_settings(args):
    model = args.model.lower()
    model_name = model_mapping[model]
    model_settings = {
        "model": model,
        "model_name": model_name,
        "max_tokens": 4096,
        "temperature": 0,
    }
    if "gpt-4o-mini" in model_name:
        model_settings["max_tokens"] = 16384
    elif "claude-3-5-sonnet" in model_name:
        model_settings["max_tokens"] = 8192

    return model_settings


def get_output_settings(args, task_settings):
    output_settings = {
        "k": 200,
        "document_tag": task_settings.get("document_tag"),
        "output_type": task_settings.get("output_type", "txt"),
        "end_tag": task_settings.get("end_tag", "\\end{document}"),
    }
    return output_settings


def get_prompt_settings(args, prompt_path, task_settings, task, prompt_dict):
    print("prompt_path:", colored(f"{prompt_path}", "yellow"))
    print("task:", colored(f"{task}", "yellow"))

    prompt_settings = {
        "prompt_path": prompt_path,
        "system_prompt": prompt_dict.get("system_prompt", ""),
        "user_prefix_prompt": prompt_dict.get("user_prefix", ""),
        "user_request_prompt": prompt_dict.get("user_request", ""),
        "user_reflect_prompt": prompt_dict.get("user_reflect", ""),
        "prefill_first": task_settings.get("prefill_first"),
        "use_prefill_from_input": False,
        "include_tex_count": args.include_tex_count,
        "auto_extract_figure": args.auto_extract_figure,
        "auto_extract_tikz_figure": args.auto_extract_tikz_figure,
        "include_tikz_reflection": args.include_tikz_reflection,
    }

    if task_settings.get("prefill_reflect"):
        prompt_settings["prefill_reflect"] = task_settings.get("prefill_reflect")
    else:
        prompt_settings["prefill_reflect"] = prompt_settings["prefill_first"]

    return prompt_settings
