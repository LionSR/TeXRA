from termcolor import colored
import os
from .file_utils import read_file
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png

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


def get_summary_string(state, model):
    total_input_tokens = state["total_input_tokens"]
    total_output_tokens = state["total_output_tokens"]
    total_response_time = state["total_response_time"]
    cost = compute_api_price(total_input_tokens, total_output_tokens, model)

    return (
        f"Total input tokens  : {total_input_tokens}\n"
        f"Total output tokens : {total_output_tokens}\n"
        f"Total response time : {total_response_time:.2f} seconds\n"
        f"Total cost          : ${cost:.2f}\n"
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


def handle_prefill(
    model,
    output_type,
    use_prefill_from_input,
    assistant_prefill_first,
    input_file,
    k,
    append_mode,
    output_file,
    messages,
    document_tag,
    overwrite,
):
    accumulated_output = assistant_prefill_first
    if output_type == "tex":
        if use_prefill_from_input:
            first_k_tex_document = read_file(input_file)[:k].strip()
            assistant_prefill_first += first_k_tex_document
            if is_anthropic_model(model):
                accumulated_output = first_k_tex_document
            elif is_openai_model(model):
                accumulated_output = ""
                messages.append({"role": "assistant", "content": "```latex"})
        elif "<scratchpad>" not in assistant_prefill_first:
            accumulated_output = ""

    if is_anthropic_model(model):
        if append_mode and os.path.exists(output_file):
            file_content = read_file(output_file).strip()
            if output_type == "tex" and "\\end{document}" in file_content:
                print("end_tag detected in existing file content. Overwriting...")
                overwrite = True
                print(f"assistant_prefill_first: {colored(assistant_prefill_first, 'yellow')}")
                messages.append({"role": "assistant", "content": assistant_prefill_first})
            else:
                accumulated_output = file_content
                messages.append({"role": "assistant", "content": file_content})
                print(f"Using existing file content as prefill: {colored(output_file, 'green')}")
        else:
            print(f"assistant_prefill_first: {colored(assistant_prefill_first, 'yellow')}")
            messages.append({"role": "assistant", "content": assistant_prefill_first})

    encounter_document_tag = f"</{document_tag}>" in accumulated_output
    if encounter_document_tag:
        raise ValueError(f"</{document_tag}> encountered in the prefill.")

    return accumulated_output, messages, overwrite


def handle_images(figure_inputs, model):
    image_contents = []

    if not isinstance(figure_inputs, list):
        figure_inputs = [figure_inputs]

    for figure_input in figure_inputs:
        _, file_extension = os.path.splitext(figure_input)
        if file_extension.lower() == ".pdf":
            img_data = single_page_pdf_to_png(figure_input)
            media_type = "image/png"
        else:
            img_data = get_base64_encoded_image(figure_input)
            media_type = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".png": "image/png",
                ".gif": "image/gif",
                ".webp": "image/webp",
            }.get(file_extension.lower(), "image/jpeg")

        image_contents.append({"file_name": os.path.basename(figure_input), "data": img_data, "media_type": media_type})

    content = []
    for image in image_contents:
        content.extend(
            [
                {"type": "text", "text": f"Image: {image['file_name']}"},
                {
                    "type": "image_url" if is_openai_model(model) else "image",
                    "image_url"
                    if is_openai_model(model)
                    else "source": {
                        "url"
                        if is_openai_model(model)
                        else "type": (f"data:{image['media_type']};base64,{image['data']}" if is_openai_model(model) else "base64"),
                        "media_type": image["media_type"],
                        "data": image["data"],
                    },
                },
            ]
        )

    return content


def create_response(
    client,
    messages,
    model_settings,
):
    model = model_settings["model"]
    model_name = model_settings["model_name"]
    max_tokens = model_settings["max_tokens"]
    temperature = model_settings["temperature"]
    end_tag = model_settings["end_tag"]
    system_prompt = model_settings["system_prompt"]

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
