model_mapping = {
    "sonnet+": "claude-3-5-sonnet-20240620",
    "opus": "claude-3-opus-20240229",
    "sonnet": "claude-3-sonnet-20240229",
    "haiku": "claude-3-haiku-20240307",
    "gpt4o": "gpt-4o-2024-05-13",
    "gpt4t": "gpt-4-turbo-2024-04-09",
}


def is_openai_model(model):
    return "gpt" in model


def is_anthropic_model(model):
    if model in ["sonnet+", "opus", "sonnet", "haiku"]:
        return True
    if model in [
        "claude-3-5-sonnet",
        "claude-3-haiku",
        "claude-3-sonnet",
        "claude-3-opus",
    ]:
        return True
    if model in [
        "claude-3-sonnet-20240229",
        "claude-3-5-sonnet-20240620",
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
    if "sonnet" in model:
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
