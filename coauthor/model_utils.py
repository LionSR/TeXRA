from dotenv import load_dotenv

load_dotenv()

model_mapping = {
    "sonnet+": "claude-3-5-sonnet-20240620",
    "opus": "claude-3-opus-20240229",
    "sonnet": "claude-3-sonnet-20240229",
    "haiku": "claude-3-haiku-20240307",
    "gpt4o": "gpt-4o-2024-08-06",
    "gpt4t": "gpt-4-turbo-2024-04-09",
    "gpt4o-": "gpt-4o-mini-2024-07-18",
    "gpt4oOR": "openai/gpt-4o:extended",
    "gemini1p+OR": "google/gemini-pro-1.5",
    "gemini1f+OR": "google/gemini-flash-1.5",
    "llama3+OR": "meta-llama/llama-3.1-405b-instruct",
}

anthropic_models = {
    "claude-3-5-sonnet",
    "claude-3-haiku",
    "claude-3-sonnet",
    "claude-3-opus",
    "claude-3-sonnet-20240229",
    "claude-3-5-sonnet-20240620",
    "claude-3-opus-20240229",
    "claude-3-haiku-20240307",
    "sonnet+",
    "opus",
    "sonnet",
    "haiku",
}

openai_models = {
    "gpt4o",
    "gpt4t",
    "gpt4o-",
}

openrouter_models = {
    "gpt4oOR",
    "gemini1p+OR",
    "gemini1f+OR",
    "llama3+OR",
    "openai/gpt-4o:extended",
    # "google/gemini-pro-1.5-exp",
    "google/gemini-pro-1.5",
    "google/gemini-flash-1.5",
    "meta-llama/llama-3.1-405b-instruct",
}


def is_openai_model(model):
    return "gpt" in model


def is_anthropic_model(model):
    return model in anthropic_models


def is_openrouter_model(model):
    return "OR" in model or "/" in model


def get_model_client(model):
    import os

    if is_openrouter_model(model):
        from openai import OpenAI

        return OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.getenv("OPENROUTER_API_KEY"))
    elif is_openai_model(model):
        from openai import OpenAI

        return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    elif is_anthropic_model(model):
        from anthropic import Anthropic

        return Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    else:
        raise ValueError("Unsupported model type")


def compute_api_price(input_tokens, output_tokens, model):
    prices = {
        "sonnet": (3, 15),
        "opus": (15, 75),
        "haiku": (0.25, 1.25),
        "gpt4t": (10, 30),
        "gpt4o": (2.5, 10),
        "gpt4o-": (0.15, 0.6),
        "gpt4oOR": (6, 18),
        "gemini1p+OR": (2.5, 7.5),
        "gemini1f+OR": (0.075, 0.3),
        "llama3+OR": (3, 3),
    }

    for key, (input_rate, output_rate) in prices.items():
        if key in model:
            return (input_tokens * input_rate + output_tokens * output_rate) / 1e6

    raise ValueError(f"Invalid model name '{model}' for computing price.")
