from dotenv import load_dotenv

load_dotenv()

model_mapping = {
    "sonnet+": "claude-3-5-sonnet-20240620",
    "opus": "claude-3-opus-20240229",
    "sonnet": "claude-3-sonnet-20240229",
    "haiku": "claude-3-haiku-20240307",
    "gpto1": "o1-preview-2024-09-12",
    "gpto1-": "o1-mini-2024-09-12",
    "gpt4o": "gpt-4o-2024-08-06",
    "gpt4t": "gpt-4-turbo-2024-04-09",
    "gpt4o-": "gpt-4o-mini-2024-07-18",
    "gpt4ol": "chatgpt-4o-latest",
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
    "gpt4ol",
    "gpto1",
    "gpto1-",
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


def get_model_settings(args):
    model = args.model
    model_name = model_mapping[model]

    max_tokens_mapping = {
        "openai/gpt-4o:extended": 64000,
        # "google/gemini-pro-1.5-exp": 32768,
        "google/gemini-pro-1.5": 32768,
        "google/gemini-flash-1.5": 32768,
        "meta-llama/llama-3-1b-8192": 131072,
        "claude-3-5-sonnet-20240620": 8192,
        "gpt-4o-mini-2024-07-18": 16384,
        "gpt-4o-2024-08-06": 16384,
        "o1-preview-2024-09-12": 32768,
        "o1-mini-2024-09-12": 65536,
        "chatgpt-4o-latest": 16384,
    }

    model_settings = {
        "model": model,
        "model_name": model_name,
        "max_tokens": max_tokens_mapping.get(model_name, 4096),
        "temperature": args.temperature,
    }

    return model_settings


def compute_api_price(model, input_tokens, output_tokens, cache_creation_input_tokens=None, cache_read_input_tokens=None):
    prices = {
        "sonnet": (3, 15),
        "sonnet+": (3, 15),
        "opus": (15, 75),
        "haiku": (0.25, 1.25),
        "gpt4t": (10, 30),
        "gpt4o": (2.5, 10),
        "gpt4o-": (0.15, 0.6),
        "gpt4oOR": (6, 18),
        "gpto1": (15, 60),
        "gpto1-": (3, 12),
        "gpt4ol": (5, 15),
        "gemini1p+OR": (2.5, 7.5),
        "gemini1f+OR": (0.075, 0.3),
        "llama3+OR": (3, 3),
    }
    models_with_prompt_caching_support = ["sonnet+", "haiku", "opus"]

    prompt_cache_creation_prices = {
        model: tuple(rate * 1.25 for rate in rates) for model, rates in prices.items() if model in models_with_prompt_caching_support
    }
    prompt_cache_read_prices = {
        model: tuple(rate * 0.1 for rate in rates) for model, rates in prices.items() if model in models_with_prompt_caching_support
    }

    total_price = 0

    for key, (input_rate, output_rate) in prices.items():
        if key in model:
            total_price = (input_tokens * input_rate + output_tokens * output_rate) / 1e6
            if cache_creation_input_tokens:
                total_price += (cache_creation_input_tokens * prompt_cache_creation_prices[model][0]) / 1e6
            if cache_read_input_tokens:
                total_price += (cache_read_input_tokens * prompt_cache_read_prices[model][0]) / 1e6

            return total_price

    raise ValueError(f"Invalid model name '{model}' for computing price.")
