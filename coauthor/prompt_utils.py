import os
from termcolor import colored
import xml.etree.ElementTree as ET

from .file_utils import read_file


def load_xml(file_path):
    tree = ET.parse(file_path)
    return tree.getroot()


def merge_dicts(base, override):
    result = base.copy()
    for key, value in override.items():
        if isinstance(value, dict) and key in result:
            result[key] = merge_dicts(result[key], value)
        else:
            result[key] = value
    return result


def load_agent_settings_and_prompts(prompt_path, agent):
    def load_agent_xml(prompt_path, agent_name):
        agent_prompt_file = f"{prompt_path}/prompts_{agent_name}.xml"
        if not os.path.exists(agent_prompt_file):
            raise FileNotFoundError(f"Task prompt file not found: {agent_prompt_file}")

        root = load_xml(agent_prompt_file)
        parent = root.get("inherits")

        if parent:
            parent_settings, parent_prompts = load_agent_xml(prompt_path, parent)
            agent_settings = {child.tag: child.text for child in root.find("settings") or []}
            agent_prompts = {child.tag: child.text.strip() for child in root.find("prompts") or []}

            settings = merge_dicts(parent_settings, agent_settings)
            prompts = merge_dicts(parent_prompts, agent_prompts)
        else:
            settings = {child.tag: child.text for child in root.find("settings")}
            prompts = {child.tag: child.text.strip() for child in root.find("prompts")}

        return settings, prompts

    return load_agent_xml(prompt_path, agent)


def get_xml_format_from_file(file):
    return f'<document name="{file}">\n' f"{read_file(file)}\n" f"</document>"


def get_xml_format_from_files(files):
    if files:
        return "\n".join(get_xml_format_from_file(file) for file in files)
    else:
        return ""


def load_prompt(prompt_type, prompt_settings):
    prompt = prompt_settings.get(f"{prompt_type}_prompt", "")
    print(f"{prompt_type}: {colored(prompt, 'magenta')}")
    return prompt


# in the future split the following into a different file (maybe share with base_agents or a standalone file to be shared with different chains)
def get_user_vars_basic(args):
    user_vars = {
        "INPUT_FILE": args.input_file,
        "INPUT_CONTENT": read_file(args.input_file),
        "INSTRUCTION": args.instruction if args.instruction else None,
        "SAMPLE_FILE": args.sample_files[0] if args.sample_files else None,
        "SAMPLE_CONTENT": read_file(args.sample_files[0]) if args.sample_files else None,
    }
    return user_vars


def update_user_vars_single_output(args, user_vars):
    user_vars["ADDITIONAL_INPUT_CONTENTS"] = ""
    if args.input_files:
        user_vars["ADDITIONAL_INPUT_CONTENTS"] = get_xml_format_from_files(args.input_files)

    user_vars["AUXILIARY_FILE"] = ""
    user_vars["AUXILIARY_CONTENT"] = ""
    user_vars["AUXILIARY_FILES"] = ""
    if args.auxiliary_files:
        if len(args.auxiliary_files) > 1:
            user_vars["AUXILIARY_FILES"] = get_xml_format_from_files(args.auxiliary_files)
        else:
            user_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_files[0])
            user_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])


def update_user_vars_multiple_output(args, user_vars):
    input_files = [args.input_file] + (args.input_files or [])
    if not args.output_files:
        raise ValueError("Output files are required for multiple output agents.")
    if len(args.output_files) > len(input_files):
        raise ValueError("Number of output files must not be greater than the number of input files.")

    user_vars["INPUT_FILE"] = args.input_file
    user_vars["INPUT_CONTENT"] = read_file(args.input_file)
    user_vars["ADDITIONAL_INPUT_CONTENTS"] = get_xml_format_from_files(input_files[1:])

    if args.auxiliary_files:
        user_vars["AUXILIARY_FILE"] = args.auxiliary_files[0]
        user_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])
    else:
        user_vars["AUXILIARY_FILE"] = "No auxiliary file provided"
        user_vars["AUXILIARY_CONTENT"] = "No auxiliary content"

    user_vars["AUXILIARY_FILE_CONTENTS"] = get_xml_format_from_files(args.auxiliary_files)

    user_vars["OUTPUT_FILES_ORDER"] = ", ".join(args.output_files)
