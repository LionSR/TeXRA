from termcolor import colored

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
    if model in [
        "claude-3-sonnet-20240229",
        "claude-3-opus-20240229",
        "claude-3-haiku-20240307",
    ]:
        return True
    return False


def get_model_client(model, api_key=None):
    from openai import OpenAI
    from anthropic import Anthropic
    import os

    model_name = model_mapping[model]
    if is_openai_model(model):
        OPENAI_API_KEY = api_key or os.getenv("OPENAI_API_KEY")
        client = OpenAI(api_key=OPENAI_API_KEY)
    elif is_anthropic_model(model):
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


def print_message_summary(state, model):
    total_input_tokens = state["total_input_tokens"]
    total_output_tokens = state["total_output_tokens"]
    total_response_time = state["total_response_time"]
    print(
        f"Total input tokens  : {colored(total_input_tokens, 'cyan')}\n"
        f"Total output tokens : {colored(total_output_tokens, 'cyan')}\n"
        f"Total response time : {colored(total_response_time, 'green')} seconds\n"
        f"Total cost          : ${compute_api_price(total_input_tokens, total_output_tokens, model):.2f}"
    )


def extract_response_statistics(response_object, model, end_tag=None):
    if is_openai_model(model):
        input_tokens = response_object.usage.prompt_tokens
        output_tokens = response_object.usage.completion_tokens
        stop_reason = response_object.choices[0].finish_reason
        new_response = response_object.choices[0].message.content.strip()
    elif is_anthropic_model(model):
        input_tokens = response_object.usage.input_tokens
        output_tokens = response_object.usage.output_tokens
        stop_reason = response_object.stop_reason
        if output_tokens == 3:
            print("Some errors might have appeared. No output generated")
            print(f"### DEBUG response_object: {response_object}")
            print(f"### DEBUG response_object.content: {response_object.content}")
            raise ValueError("No output generated")
        if response_object.type == "error":
            print("Error from the API:")
            print(f"### DEBUG output_tokens: {output_tokens}")
            print(f"### DEBUG error: {response_object.error}")
            raise ValueError("Error from the API")
        new_response = response_object.content[0].text.strip()
    else:
        raise ValueError(f"Unsupported model: {model}")

    if "stop" in stop_reason and "\\end{document}" not in new_response:
        new_response += "\n" + end_tag

    return new_response, input_tokens, output_tokens, stop_reason


def create_response(
    client,
    model,
    model_name,
    max_tokens,
    messages,
    temperature,
    end_tag,
    system_prompt=None,
):
    if is_openai_model(model):
        response_object = client.chat.completions.create(
            model=model_name,
            max_tokens=max_tokens,
            messages=messages,
            temperature=temperature,
            stop=end_tag,
        )
    elif is_anthropic_model(model):
        response_object = client.messages.create(
            model=model_name,
            max_tokens=max_tokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[end_tag] if end_tag else None,
            system=system_prompt,
        )
    else:
        raise ValueError(f"Unsupported model: {model}")

    return response_object
