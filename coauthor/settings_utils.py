from .logging_utils import logger


def get_output_settings(args, agent_settings):
    output_settings = {
        "k": 200,
        "document_tag": agent_settings.get("document_tag"),
        "output_ext": agent_settings.get("output_ext", "txt"),
        "end_tag": agent_settings.get("end_tag", "\\end{document}"),
        "prefills": agent_settings.get("prefills", []),
        "temperature": args.temperature,
    }
    return output_settings


def get_prompt_settings(args, agent_path, prompt_dict):
    logger.info(f"agent_path: {agent_path}")

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
