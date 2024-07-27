import os
from .file_utils import read_file
from termcolor import colored
import xml.etree.ElementTree as ET


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


def load_task_settings_and_prompts(prompt_path, task):
    def load_task_xml(prompt_path, task_name):
        task_file = f"{prompt_path}/prompts_{task_name}.xml"
        if not os.path.exists(task_file):
            raise FileNotFoundError(f"Task file not found: {task_file}")

        root = load_xml(task_file)
        parent = root.get("inherits")

        if parent:
            parent_settings, parent_prompts = load_task_xml(prompt_path, parent)
            task_settings = {child.tag: child.text for child in root.find("settings") or []}
            task_prompts = {child.tag: child.text.strip() for child in root.find("prompts") or []}

            settings = merge_dicts(parent_settings, task_settings)
            prompts = merge_dicts(parent_prompts, task_prompts)
        else:
            settings = {child.tag: child.text for child in root.find("settings")}
            prompts = {child.tag: child.text.strip() for child in root.find("prompts")}

        return settings, prompts

    return load_task_xml(prompt_path, task)


def get_user_prefix_vars(args):
    user_prefix_vars = {
        "INPUT_FILE": os.path.basename(args.input_file),
        "INPUT_CONTENT": read_file(args.input_file),
        "INSTRUCTION": args.instruction if args.instruction else None,
    }
    return user_prefix_vars


def format_file_content(files, start_index):
    return "\n".join(
        f'<document index="{i + start_index}">\n'
        f"<source>{os.path.basename(file)}</source>\n"
        f"<document_content>\n"
        f"{read_file(file)}\n"
        f"</document_content>\n"
        f"</document>"
        for i, file in enumerate(files)
    )


def get_auxiliary_files_content(auxiliary_files):
    return format_file_content(auxiliary_files, 2) if auxiliary_files else ""


def get_additional_input_files_content(input_files, num_auxiliary_files):
    return format_file_content(input_files, num_auxiliary_files + 2) if input_files else ""


def load_prompt(prompt_type, prompt_settings):
    prompt = prompt_settings.get(f"{prompt_type}_prompt", "")
    print(f"{prompt_type}: {colored(prompt, 'magenta')}")
    return prompt


def handle_single_output(args, user_prefix_vars):
    user_prefix_vars["AUXILIARY_FILE"] = ""
    user_prefix_vars["AUXILIARY_CONTENT"] = ""
    user_prefix_vars["AUXILIARY_FILES"] = ""
    if args.auxiliary_files:
        if len(args.auxiliary_files) > 1:
            user_prefix_vars["AUXILIARY_FILES"] = get_auxiliary_files_content(args.auxiliary_files)
        else:
            user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_files[0])
            user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])

    user_prefix_vars["ADDITIONAL_INPUT_FILES"] = ""
    if args.input_files:
        user_prefix_vars["ADDITIONAL_INPUT_FILES"] = get_additional_input_files_content(
            args.input_files, len(args.auxiliary_files) if args.auxiliary_files else 0
        )


def handle_multiple_output(args, user_prefix_vars):
    input_files = [args.input_file] + (args.input_files or [])
    if len(input_files) < 2:
        raise ValueError("At least two input files are required for polish_multiple task.")
    if not args.output_files or len(args.output_files) != len(input_files):
        raise ValueError("Number of output files must match the number of input files.")

    user_prefix_vars["ADDITIONAL_INPUT_FILES"] = ""
    for i, input_file in enumerate(input_files[1:], start=2):
        content = read_file(input_file)
        user_prefix_vars[
            "ADDITIONAL_INPUT_FILES"
        ] += f"""
<document index="{i}">
<source>{input_file}</source>
<document_content>
{content}
</document_content>
</document>"""

    user_prefix_vars["OUTPUT_FILES_ORDER"] = ", ".join(args.output_files)

    if args.auxiliary_files:
        user_prefix_vars["AUXILIARY_FILE"] = args.auxiliary_files[0]
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])
    else:
        user_prefix_vars["AUXILIARY_FILE"] = "No auxiliary file provided"
        user_prefix_vars["AUXILIARY_CONTENT"] = "No auxiliary content"

    # prompt_settings["user_prefix_file"] = prompt_settings["user_prefix_file"].replace("polish.txt", "polish_multiple.txt")

    user_prefix_vars["INPUT_FILE"] = args.input_file
    user_prefix_vars["INPUT_CONTENT"] = read_file(args.input_file)

    user_prefix_vars["AUXILIARY_FILE_CONTENT"] = (
        f"""
<document index="0">
<source>{user_prefix_vars['AUXILIARY_FILE']}</source>
<document_content>
{user_prefix_vars['AUXILIARY_CONTENT']}
</document_content>
</document>
"""
        if user_prefix_vars["AUXILIARY_FILE"] != "No auxiliary file provided"
        else ""
    )
