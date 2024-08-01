from dotenv import load_dotenv

load_dotenv()

model_mapping = {
    "sonnet+": "claude-3-5-sonnet-20240620",
    "opus": "claude-3-opus-20240229",
    "sonnet": "claude-3-sonnet-20240229",
    "haiku": "claude-3-haiku-20240307",
    "gpt4o": "gpt-4o-2024-05-13",
    "gpt4t": "gpt-4-turbo-2024-04-09",
    "gpt4o-": "gpt-4o-mini-2024-07-18",
}

anthropic_models = set(model_mapping.keys()) | {
    "claude-3-5-sonnet",
    "claude-3-haiku",
    "claude-3-sonnet",
    "claude-3-opus",
    "claude-3-sonnet-20240229",
    "claude-3-5-sonnet-20240620",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
}


def is_openai_model(model):
    return "gpt" in model


def is_anthropic_model(model):
    return model in anthropic_models


def get_model_client(model):
    import os

    if is_openai_model(model):
        from openai import OpenAI

        return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    elif is_anthropic_model(model):
        from anthropic import Anthropic

        return Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    else:
        raise ValueError("Unsupported model type")


def compute_api_price(input_tokens, output_tokens, model):
    prices = {"sonnet": (3, 15), "opus": (15, 75), "haiku": (0.25, 1.25), "gpt4t": (10, 30), "gpt4o": (5, 15), "gpt4o-": (0.15, 0.6)}

    for key, (input_rate, output_rate) in prices.items():
        if key in model:
            return (input_tokens * input_rate + output_tokens * output_rate) / 1e6

    raise ValueError(f"Invalid model name '{model}' for computing price.")
