from .logging_utils import logger


def get_agent_settings(args, agent_settings):
    agent_settings = {
        "K": 200,
        "temperature": args.temperature,
        "document_tag": agent_settings.get("document_tag"),
        "output_ext": agent_settings.get("output_ext", "txt"),
        "end_tag": agent_settings.get("end_tag", "\\end{document}"),
    }
    return agent_settings


def get_agent_prompts(args, agent_path, prompt_dict):
    logger.info(f"agent_path: {agent_path}")

    agent_prompts = {
        # prefills
        "use_prefill_from_input": args.use_prefill_from_input,
        "prefills": prompt_dict.get("prefills", []),
        # prompt
        "system_prompt": prompt_dict.get("system_prompt", ""),
        "user_prefix_prompt": prompt_dict.get("user_prefix", ""),
        "user_request_prompt": prompt_dict.get("user_request", ""),
        "user_reflect_prompt": prompt_dict.get("user_reflect", ""),
    }
    return agent_prompts


def get_task_config(args):
    task_config = {
        "input_files": args.input_files,
        "auxiliary_files": args.auxiliary_files,
        "figure_inputs": args.figure_inputs,
        "sample_files": args.sample_files,
        "output_files": args.output_files,
        "instruction": args.instruction,
        "reflect": args.reflect,
        # tooluse
        # "include_tex_count": args.include_tex_count,
        # "auto_extract_figure": args.auto_extract_figure,
        # "auto_extract_tikz_figure": args.auto_extract_tikz_figure,
        # "include_tikz_reflection": args.include_tikz_reflection,
    }
    return task_config
