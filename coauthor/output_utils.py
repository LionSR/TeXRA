import os
from termcolor import colored
from .file_utils import read_file, write_file, append_file


def get_output_file_name(input_file, task, model, output_type, reflect=False):
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    if reflect:
        output_file = output_file.replace(f"_{model}", f"_reflect_{model}")
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def split_scratchpad_output(output_file, document_tag="latex_document"):
    _, extension = os.path.splitext(output_file)
    log_file_thinking = output_file.replace(f"{extension}", "_thinking.txt")
    print(f"Log file: {colored(log_file_thinking, 'cyan')}")
    output_content = read_file(output_file)

    # Replace "\end{document>" with "\end{document}" for sonnet 3.5
    output_content = output_content.replace("\\end{document>", "\\end{document}")

    if "</scratchpad>" in output_content:
        append_file(log_file_thinking, "<scratchpad>\n" + output_content.split("</scratchpad>")[0] + "</scratchpad>\n")

        output_content = output_content.split(
            ("<" + document_tag + ">" if "<" + document_tag + ">" in output_content else "</scratchpad>"),
            1,
        )[1].lstrip()
        write_file(output_file, output_content)

    return output_content
