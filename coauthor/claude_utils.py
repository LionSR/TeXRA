model_mapping = {
    "sonnet": "claude-3-sonnet-20240229",
    "opus": "claude-3-opus-20240229",
    "haiku": "claude-3-haiku-20240307",
}


def compute_anthropic_price(input_tokens, output_tokens, model):
    if model == "sonnet":
        input_price = input_tokens * 3 / 1e6
        output_price = output_tokens * 15 / 1e6
    elif model == "opus":
        input_price = input_tokens * 15 / 1e6
        output_price = output_tokens * 75 / 1e6
    elif model == "haiku":
        input_price = input_tokens * 0.25 / 1e6
        output_price = output_tokens * 1.25 / 1e6
    else:
        raise ValueError("Invalid model name for computing price.")
    return input_price + output_price
