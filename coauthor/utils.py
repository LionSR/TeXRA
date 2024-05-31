from termcolor import colored
import difflib

model_mapping = {
    "sonnet": "claude-3-sonnet-20240229",
    "opus": "claude-3-opus-20240229",
    "haiku": "claude-3-haiku-20240307",
    "gpt4o": "gpt-4o-2024-05-13",
    "gpt4t": "gpt-4-turbo-2024-04-09",
}


def is_openai_model(model):
    return "gpt" in model


def is_anthropic_model(model):
    if model in ["opus", "sonnet", "haiku"]:
        return True
    if model in ["claude-3-haiku", "claude-3-sonnet", "claude-3-opus"]:
        return True
    return False


def get_model_client(model, api_key=None):
    from openai import OpenAI
    from anthropic import Anthropic
    import os

    model_name = model_mapping[model]
    if "gpt" in model:
        OPENAI_API_KEY = api_key or os.getenv("OPENAI_API_KEY")
        client = OpenAI(api_key=OPENAI_API_KEY)
    elif model in [
        "opus",
        "sonnet",
        "haiku",
        "claude-3-haiku",
        "claude-3-sonnet",
        "claude-3-opus",
    ]:
        ANTHROPIC_API_KEY = api_key or os.getenv("ANTHROPIC_API_KEY")
        client = Anthropic(api_key=ANTHROPIC_API_KEY)
    else:
        raise ValueError("Unsupported model type")
    return client, model_name


def compute_api_price(input_tokens, output_tokens, model):
    if model == "sonnet":
        input_price = input_tokens * 3 / 1e6
        output_price = output_tokens * 15 / 1e6
    elif model == "opus":
        input_price = input_tokens * 15 / 1e6
        output_price = output_tokens * 75 / 1e6
    elif model == "haiku":
        input_price = input_tokens * 0.25 / 1e6
        output_price = output_tokens * 1.25 / 1e6
    elif model == "gpt4o":
        input_price = input_tokens * 5 / 1e6
        output_price = output_tokens * 15 / 1e6
    elif model == "gpt4t":
        input_price = input_tokens * 10 / 1e6
        output_price = output_tokens * 30 / 1e6
    else:
        raise ValueError("Invalid model name for computing price.")
    return input_price + output_price


def read_file(file_path):
    with open(file_path, "r") as file:
        return file.read()


def write_file(file_path, content):
    with open(file_path, "w") as file:
        file.write(content)


def append_file(file_path, content):
    with open(file_path, "a+") as file:
        file.write(content)


def find_last_non_empty_line(response):
    lines = response.split("\n")
    last_non_empty_line_index = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            last_non_empty_line_index = i
            break
    return lines[last_non_empty_line_index]


def extract_text_from_tags(INPUT_CONTENT, document_tag):
    import re

    match = re.search(
        r"<{}>(.*?)</{}>".format(document_tag, document_tag), INPUT_CONTENT, re.DOTALL
    )
    if match:
        INPUT_CONTENT = match.group(1)
    return INPUT_CONTENT


def check_for_massive_repetition(last_response, new_response):
    sequence_matcher = difflib.SequenceMatcher(None, last_response, new_response)
    repetition_ratio = sequence_matcher.ratio()
    longest_match = sequence_matcher.find_longest_match(
        0, len(last_response), 0, len(new_response)
    )
    longest_matching_substring = last_response[
        longest_match.a : longest_match.a + longest_match.size
    ]
    massive_repetition_detected = len(longest_matching_substring) > 1000
    if massive_repetition_detected:
        print(colored(f"### repetition_ratio is {repetition_ratio}", "red"))
        print(
            colored(
                f"### Longest matching substring: {longest_matching_substring}", "red"
            )
        )
        print("WARNING: Massive repetition detected. Stopping the process.")
    return massive_repetition_detected


def print_summary(state, model):
    total_input_tokens = state["total_input_tokens"]
    total_output_tokens = state["total_output_tokens"]
    total_response_time = state["total_response_time"]
    print(
        f"Total input tokens  : {colored(total_input_tokens, 'cyan')}\n"
        f"Total output tokens : {colored(total_output_tokens, 'cyan')}\n"
        f"Total response time : {colored(total_response_time, 'green')} seconds\n"
        f"Total cost          : ${compute_api_price(total_input_tokens, total_output_tokens, model):.2f}"
    )
