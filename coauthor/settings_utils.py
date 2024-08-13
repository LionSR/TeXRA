from termcolor import colored

from .model_utils import model_mapping


def get_model_settings(args):
    model = args.model
    model_name = model_mapping[model]

    max_tokens_mapping = {
        "openai/gpt-4o:extended": 64000,
        # "google/gemini-pro-1.5-exp": 32768,
        "google/gemini-pro-1.5": 32768,
        "google/gemini-flash-1.5": 32768,
        "meta-llama/llama-3-1b-8192": 131072,
    }

    model_settings = {
        "model": model,
        "model_name": model_name,
        "max_tokens": max_tokens_mapping.get(model_name, 4096),
        "temperature": 0,
    }

    if "gpt-4o-mini" in model_name or "gpt-4o-2024-08-06" in model_name:
        model_settings["max_tokens"] = 16384
    elif "claude-3-5-sonnet" in model_name:
        model_settings["max_tokens"] = 8192

    return model_settings


def get_output_settings(args, agent_settings):
    output_settings = {
        "k": 200,
        "document_tag": agent_settings.get("document_tag"),
        "output_type": agent_settings.get("output_type", "txt"),
        "end_tag": agent_settings.get("end_tag", "\\end{document}"),
        "prefills": agent_settings.get("prefills", []),
    }

    # For backward compatibility
    if not output_settings["prefills"]:
        prefill_first = agent_settings.get("prefill_first")
        prefill_second = agent_settings.get("prefill_second")

        if prefill_first:
            output_settings["prefills"].append(prefill_first)
        if prefill_second and prefill_second != prefill_first:
            output_settings["prefills"].append(prefill_second)

    return output_settings


def get_prompt_settings(args, agent_path, prompt_dict):
    print("agent_path:", colored(f"{agent_path}", "yellow"))

    prompt_settings = {
        "agent_path": agent_path,
        "system_prompt": prompt_dict.get("system_prompt", ""),
        "user_prefix_prompt": prompt_dict.get("user_prefix", ""),
        "user_request_prompt": prompt_dict.get("user_request", ""),
        "user_reflect_prompt": prompt_dict.get("user_reflect", ""),
        "use_prefill_from_input": args.use_prefill_from_input,
        "include_tex_count": args.include_tex_count,
        "auto_extract_figure": args.auto_extract_figure,
        "auto_extract_tikz_figure": args.auto_extract_tikz_figure,
        "include_tikz_reflection": args.include_tikz_reflection,
    }

    return prompt_settings
