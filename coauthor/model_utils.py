from dotenv import load_dotenv

load_dotenv()

MODEL_MAPPING = {
    # Anthropic Claude models
    "sonnet++": "claude-3-5-sonnet-20241022",
    "sonnet+": "claude-3-5-sonnet-20240620",
    "opus": "claude-3-opus-20240229",
    "sonnet": "claude-3-sonnet-20240229",
    "haiku+": "claude-3-5-haiku-20241022",
    "haiku": "claude-3-haiku-20240307",
    # OpenAI models
    "gpto1": "o1-preview-2024-09-12",
    "gpto1-": "o1-mini-2024-09-12",
    "gpt4o": "gpt-4o-2024-08-06",
    "gpt4t": "gpt-4-turbo-2024-04-09",
    "gpt4o-": "gpt-4o-mini-2024-07-18",
    "gpt4ol": "chatgpt-4o-latest",
    # OpenRouter models
    "gpt4oOR": "openai/gpt-4o:extended",
    "gemini1p+OR": "google/gemini-pro-1.5",
    "gemini1f+OR": "google/gemini-flash-1.5",
    "llama3+OR": "meta-llama/llama-3.1-405b-instruct",
}

MODEL_MAX_TOKENS = {
    # Anthropic Claude models
    "claude-3-5-sonnet-20240620": 8192,
    "claude-3-5-sonnet-20241022": 8192,
    "claude-3-5-haiku-20241022": 8192,
    "claude-3-opus-20240229": 4096,
    # OpenAI models
    "gpt-4o-mini-2024-07-18": 16384,
    "gpt-4o-2024-08-06": 16384,
    "chatgpt-4o-latest": 16384,
    "o1-preview-2024-09-12": 32768,
    "o1-mini-2024-09-12": 65536,
    # Google Gemini models
    "gemini-1.5-pro-latest": 8192,
    "gemini-1.5-fresh-latest": 8192,
    "gemini-exp-1114": 8192,
    # OpenRouter models
    "openai/gpt-4o:extended": 64000,
    "google/gemini-pro-1.5": 32768,
    "google/gemini-flash-1.5": 32768,
    "meta-llama/llama-3-1b-8192": 131072,
    "meta-llama/llama-3.1-405b-instruct": 131072,
}

# prices are in dollars per million tokens
MODEL_PRICES = {
    "sonnet": (3, 15),
    "sonnet+": (3, 15),
    "sonnet++": (3, 15),
    "opus": (15, 75),
    "haiku": (0.25, 1.25),
    "haiku+": (1, 5.0),
    "gpt4t": (10, 30),
    "gpt4o": (2.5, 10),
    "gpt4o-": (0.15, 0.6),
    "gpt4oOR": (6, 18),
    "gpto1": (15, 60),
    "gpto1-": (3, 12),
    "gpt4ol": (5, 15),
    "gemini1p+": (1.25, 5.0),
    "gemini1f+": (0.075, 0.3),
    "geminiexp": (2.5, 7.5),
    "gemini1p+OR": (2.5, 7.5),
    "gemini1f+OR": (0.075, 0.3),
    "llama3+OR": (3, 3),
}

CLAUDE_MODELS_WITH_PROMPT_CACHING_SUPPORT = ["sonnet++", "sonnet+", "haiku", "opus", "haiku+"]


def is_openai_model(model):
    return "gpt" in model


def is_anthropic_model(model):
    return any(name in model for name in ("opus", "haiku", "sonnet"))


def is_google_model(model):
    return "gemini" in model


def is_openrouter_model(model):
    return "OR" in model or "/" in model


def is_openai_compatible_model(model):
    if "gpt" in model:
        return True
    elif is_google_model(model):
        return True
    elif is_openrouter_model(model):
        return True

    return False


def get_model_client(model):
    from os import getenv

    if is_anthropic_model(model):
        from anthropic import Anthropic

        return Anthropic(api_key=getenv("ANTHROPIC_API_KEY"))
    elif is_openai_compatible_model(model):
        from openai import OpenAI

        if is_openrouter_model(model):
            api_key = getenv("OPENROUTER_API_KEY")
            base_url = "https://openrouter.ai/api/v1"
        elif is_openai_model(model):
            api_key = getenv("OPENAI_API_KEY")
            base_url = None
        elif is_google_model(model):
            api_key = getenv("GOOGLE_API_KEY")
            base_url = "https://generativelanguage.googleapis.com/v1beta"

        return OpenAI(api_key=api_key, base_url=base_url)
    else:
        raise ValueError("Unsupported model type")


def get_model_settings(args):
    model = args.model
    model_name = MODEL_MAPPING[model]
    model_settings = {
        "model": model,
        "model_name": model_name,
        "max_tokens": MODEL_MAX_TOKENS.get(model_name, 4096),
        "temperature": args.temperature,
    }

    return model_settings


def compute_api_price(model, input_tokens, output_tokens, cache_creation_input_tokens=None, cache_read_input_tokens=None):
    # for anthropic models, the price for cache creation is 25% more than the normal price
    prompt_cache_creation_prices = {
        model: tuple(rate * 1.25 for rate in rates) for model, rates in MODEL_PRICES.items() if model in CLAUDE_MODELS_WITH_PROMPT_CACHING_SUPPORT
    }

    # for anthropic models, the price for cache read is 10% of the normal price
    prompt_cache_read_prices = {
        model: tuple(rate * 0.1 for rate in rates) for model, rates in MODEL_PRICES.items() if model in CLAUDE_MODELS_WITH_PROMPT_CACHING_SUPPORT
    }

    total_price = 0

    for key, (input_rate, output_rate) in MODEL_PRICES.items():
        if key in model:
            total_price = (input_tokens * input_rate + output_tokens * output_rate) / 1e6
            if cache_creation_input_tokens:
                total_price += (cache_creation_input_tokens * prompt_cache_creation_prices[model][0]) / 1e6
            if cache_read_input_tokens:
                total_price += (cache_read_input_tokens * prompt_cache_read_prices[model][0]) / 1e6

            return total_price

    raise ValueError(f"Invalid model name '{model}' for computing price.")
