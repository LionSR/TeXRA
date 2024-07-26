import os
from .file_utils import read_file
from termcolor import colored


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


def load_prompt(prompt_type, task, prompt_settings):
    prompt_path = prompt_settings.get("prompt_path")
    prompt_file = prompt_settings.get(f"{prompt_type}_file")
    prompt_file_path = os.path.join(prompt_path, prompt_file) if prompt_file else os.path.join(prompt_path, f"{prompt_type}_{task}.txt")
    prompt = read_file(prompt_file_path).strip()
    print(f"{prompt_type}: {colored(prompt, 'magenta')}")
    return prompt


def handle_single_input(args, user_prefix_vars, prompt_settings):
    user_prefix_vars["ADDITIONAL_INPUT_FILES"] = ""
    if args.input_files:
        raise ValueError("Input files are not allowed for non-long tasks. Please use --task=polish_long or --task=draw_long instead.")

    if args.auxiliary_files:
        if len(args.auxiliary_files) > 1:
            raise ValueError("Only one auxiliary file is allowed. Please provide a single file.")
        user_prefix_vars["AUXILIARY_FILE"] = os.path.basename(args.auxiliary_files[0])
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])
        prompt_settings["user_prefix_file"] = prompt_settings["user_prefix_file"].replace(".txt", "_with_auxiliary.txt")


def handle_long_input(args, user_prefix_vars, prompt_settings):
    print(colored(f"Handling long input for task: {args.task}", "yellow"))
    task_shared = args.task.split("_")[0]

    prompt_settings["user_prefix_file"] = f"user_prefix_{task_shared}_long.txt"
    user_prefix_vars["AUXILIARY_FILES"] = get_auxiliary_files_content(args.auxiliary_files)
    user_prefix_vars["ADDITIONAL_INPUT_FILES"] = get_additional_input_files_content(
        args.input_files, len(args.auxiliary_files) if args.auxiliary_files else 0
    )


def handle_multiple_input(args, user_prefix_vars, prompt_settings):
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

    # Handle auxiliary files
    if args.auxiliary_files:
        user_prefix_vars["AUXILIARY_FILE"] = args.auxiliary_files[0]
        user_prefix_vars["AUXILIARY_CONTENT"] = read_file(args.auxiliary_files[0])
    else:
        user_prefix_vars["AUXILIARY_FILE"] = "No auxiliary file provided"
        user_prefix_vars["AUXILIARY_CONTENT"] = "No auxiliary content"

    # Update the user_prefix_file to use the multiple input version
    prompt_settings["user_prefix_file"] = prompt_settings["user_prefix_file"].replace("polish.txt", "polish_multiple.txt")

    # Ensure the first input file is correctly set in user_prefix_vars
    user_prefix_vars["INPUT_FILE"] = args.input_file
    user_prefix_vars["INPUT_CONTENT"] = read_file(args.input_file)

    # Add AUXILIARY_FILE_CONTENT
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
