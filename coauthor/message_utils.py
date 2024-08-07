import os
from termcolor import colored, cprint

from .img_utils import get_base64_encoded_image, process_pdf_input
from .model_utils import is_openai_model, is_anthropic_model


def has_end_tag(file_content, end_tag, document_tag):
    """Check if the file content contains the end tag or document tag."""
    return end_tag in file_content or f"</{document_tag}>" in file_content


def create_response(client, messages, model_settings, output_settings, prompt_settings):
    """Create a response using the specified model and settings."""
    model = model_settings["model"]
    model_name = model_settings["model_name"]
    max_tokens = model_settings["max_tokens"]
    temperature = model_settings["temperature"]
    end_tag = output_settings["end_tag"]
    system_prompt = prompt_settings["system_prompt"]

    if is_openai_model(model):
        response_object = _create_openai_response(client, model_name, max_tokens, messages, temperature, end_tag)
    elif is_anthropic_model(model):
        response_object = _create_anthropic_response(client, model_name, max_tokens, messages, temperature, end_tag, system_prompt)
    else:
        raise ValueError(f"Unsupported model: {model}")

    return response_object


def _create_openai_response(client, model_name, max_tokens, messages, temperature, end_tag):
    """Create a response using OpenAI model."""
    response_object = client.chat.completions.create(
        model=model_name,
        max_tokens=max_tokens,
        messages=messages,
        temperature=temperature,
        stop=end_tag,
    )
    print(colored(f"using openai model: {model_name}", "green"))
    return response_object


def _create_anthropic_response(client, model_name, max_tokens, messages, temperature, end_tag, system_prompt):
    """Create a response using Anthropic model."""
    extra_headers = None
    if "claude-3-5-sonnet" in model_name.lower():
        extra_headers = {"anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"}
        max_tokens = 8192

    response_object = client.messages.create(
        model=model_name,
        max_tokens=max_tokens,
        messages=messages,
        temperature=temperature,
        stop_sequences=[end_tag] if end_tag else None,
        system=system_prompt,
        extra_headers=extra_headers,
    )
    print(colored(f"using anthropic model: {model_name}", "green"))
    return response_object


def initialize_messages(model, system_prompt, user_prefix, user_request, figure_inputs):
    """Initialize messages for the conversation."""
    messages = [{"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

    if is_openai_model(model):
        messages.insert(0, {"role": "system", "content": system_prompt})

    if figure_inputs:
        image_content = create_image_message(model, figure_inputs)
        messages[-1]["content"].extend(image_content)

    messages[-1]["content"].append({"type": "text", "text": user_request})
    return messages


def create_image_message(model, figure_inputs):
    """Create image messages for the conversation."""
    image_contents = []
    added_figures = []

    if not isinstance(figure_inputs, list):
        figure_inputs = [figure_inputs]

    figure_inputs = [str(fig) for fig in figure_inputs]

    for figure_input in figure_inputs:
        if not os.path.exists(figure_input):
            cprint(f"WARNING: File {figure_input} does not exist. Skipping.", "white", "on_red")
            continue

        _, file_extension = os.path.splitext(figure_input)
        img_data, media_type = _process_image_file(figure_input, file_extension, model)

        if img_data is not None:
            _add_image_content(image_contents, added_figures, figure_input, img_data, media_type)
        else:
            cprint(f"WARNING: Failed to process {figure_input}. Skipping.", "white", "on_red")

    content = _create_image_content(image_contents, model)

    print(f"Using images: {colored(figure_inputs, 'green')}")
    print(f"Successfully added figures: {colored(added_figures, 'cyan')}")

    return content


def _process_image_file(figure_input, file_extension, model):
    """Process the image file and return the image data and media type."""
    if file_extension.lower() == ".pdf":
        img_data = process_pdf_input(figure_input, is_openai=is_openai_model(model))
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
    return img_data, media_type


def _add_image_content(image_contents, added_figures, figure_input, img_data, media_type):
    """Add image content to the lists."""
    if isinstance(img_data, list):
        for i, data in enumerate(img_data):
            image_contents.append({"file_name": f"{os.path.basename(figure_input)}_page_{i+1}", "data": data, "media_type": media_type})
        added_figures.extend([f"{figure_input}_page_{i+1}" for i in range(len(img_data))])
    else:
        image_contents.append({"file_name": os.path.basename(figure_input), "data": img_data, "media_type": media_type})
        added_figures.append(figure_input)


def _create_image_content(image_contents, model):
    """Create the image content for the message."""
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


def extract_response_statistics(response_object, model, end_tag=None):
    """Extract statistics from the response object."""
    if is_openai_model(model):
        return _extract_openai_statistics(response_object, end_tag)
    elif is_anthropic_model(model):
        return _extract_anthropic_statistics(response_object, end_tag)
    else:
        raise ValueError(f"Unsupported model: {model}")


def _extract_openai_statistics(response_object, end_tag):
    """Extract statistics from OpenAI response object."""
    input_tokens = response_object.usage.prompt_tokens
    output_tokens = response_object.usage.completion_tokens
    stop_reason = response_object.choices[0].finish_reason
    new_response = response_object.choices[0].message.content.strip()

    if "stop" in stop_reason and "\\end{document}" not in new_response:
        new_response += f"\n{end_tag}"

    return new_response, input_tokens, output_tokens, stop_reason


def _extract_anthropic_statistics(response_object, end_tag):
    """Extract statistics from Anthropic response object."""
    input_tokens = response_object.usage.input_tokens
    output_tokens = response_object.usage.output_tokens
    stop_reason = response_object.stop_reason

    if output_tokens == 3:
        cprint("WARNING: Some errors might have appeared. No output generated", "white", "on_red")
        print(f"### DEBUG response_object: {response_object}")
        print(f"### DEBUG response_object.content: {response_object.content}")
        raise ValueError("No output generated")

    if response_object.type == "error":
        cprint("WARNING: Error from the API:", "white", "on_red")
        print(f"### DEBUG output_tokens: {output_tokens}")
        print(f"### DEBUG error: {response_object.error}")
        raise ValueError("Error from the API")

    new_response = response_object.content[0].text.strip()

    if "stop" in stop_reason and "\\end{document}" not in new_response:
        new_response += f"\n{end_tag}"

    return new_response, input_tokens, output_tokens, stop_reason


def handle_openai_continuation(messages, new_response, k, end_tag):
    """Handle continuation for OpenAI models."""
    prefill_tokens = new_response[-k:]
    user_message_continuation = (
        f"Your response got cut off, because you only have limited response space. "
        f"Continue writing exactly from where you left off until the very end, "
        f'marked by {end_tag}. Avoid repeat yourself and avoid starting over. Start your response at the next token after: "{prefill_tokens}"'
    )
    print("User message:", colored(user_message_continuation, "magenta"))
    messages.append({"role": "user", "content": user_message_continuation})


def check_stop_conditions(stop_reason, new_response, state, output_settings, massive_repetition_detected):
    """Check if the conversation should stop."""
    end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
    encounter_document_tag = f"</{output_settings['document_tag']}>" in new_response
    continuation_limit = state["continuation_count"] > 10
    input_token_limit = state["total_input_tokens"] > 1000000
    output_token_limit = state["total_output_tokens"] > 2.5 * state["first_input_tokens"]

    if output_token_limit:
        cprint("WARNING: Total output tokens exceed 2.5 times the number of the first input tokens. Halting the process.", "white", "on_red")

    should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

    return end_turn, should_stop


def print_stop_flags(end_turn, new_response, state, output_settings, massive_repetition_detected):
    """Print the flags indicating why the conversation stopped."""
    print("Printing the flags")
    print(f"end_turn: {end_turn}")
    print(f"encounter_document_tag: {'</latex_document>' in new_response}")
    print(f"continuation_limit: {state['continuation_count'] > 10}")
    print(f"input_token_limit: {state['total_input_tokens'] > 100000}")
    print(f"massive_repetition_detected: {massive_repetition_detected}")
    print(f"output_token_limit: {state['total_output_tokens'] > 2.5 * state['first_input_tokens']}")
    print(f"### The last {output_settings['k']} characters of the previous response are:")
    print(colored(f"### {state['last_response'][-output_settings['k']:]}", "yellow"))
