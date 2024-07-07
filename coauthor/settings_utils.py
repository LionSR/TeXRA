from .model_utils import model_mapping
from termcolor import colored


def get_model_settings(args):
    model_settings = {
        "model": args.model,
        "model_name": model_mapping[args.model],
        "max_tokens": 4096,
        "temperature": 0,
    }

    return model_settings


def get_output_settings(args, task_settings):
    output_settings = {
        "k": 200,
        "document_tag": task_settings.get("document_tag"),
        "output_type": task_settings.get("output_type", "txt"),
        "end_tag": task_settings.get("end_tag", "\\end{document}"),
    }
    return output_settings


def get_prompt_settings(args, prompt_path, task_settings, task):
    print(colored(f"prompt_path: {prompt_path}", "yellow"), colored(f"task: {task}", "yellow"))

    prompt_settings = {
        "prompt_path": prompt_path,
        "system_prompt_file": f"system_prompt_{task}.txt",
        "user_prefix_file": f"user_prefix_{task}.txt",
        "user_request_file": f"user_request_{task}.txt",
        "user_reflect_file": f"user_reflect_{task}.txt",
        "prefill_first": task_settings.get("prefill_first"),
        "prefill_first_reflect": task_settings.get("first_prefill_reflect"),
        "use_prefill_from_input": False,
        "include_tex_count": args.include_tex_count,
        "auto_extract_figure": args.auto_extract_figure,
        "auto_extract_tikz_figure": args.auto_extract_tikz_figure,
        "include_tikz_reflection": args.include_tikz_reflection,
    }

    for key in ["system_prompt_file", "user_prefix_file", "user_request_file", "user_reflect_file"]:
        if key in task_settings and task_settings[key] is not None:
            prompt_settings[key] = task_settings[key]

    return prompt_settings
