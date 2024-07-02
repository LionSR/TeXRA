from termcolor import colored
import os
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png
from .model_utils import is_openai_model, is_anthropic_model


def has_end_tag(file_content, end_tag, document_tag):
    """
    Check if the end tag or document tag is present in the given file content.

    Args:
        file_content (str): The content of the file to check.
        end_tag (str): The end tag to look for.
        document_tag (str): The document tag to look for.

    Returns:
        bool: True if the end tag or document tag is found, False otherwise.
    """
    return end_tag in file_content or f"</{document_tag}>" in file_content or "\\end{document}" in file_content


def create_response(client, messages, model_settings, output_settings, prompt_settings):
    model = model_settings["model"]
    model_name = model_settings["model_name"]
    max_tokens = model_settings["max_tokens"]
    temperature = model_settings["temperature"]
    end_tag = output_settings["end_tag"]
    system_prompt = prompt_settings["system_prompt"]

    if is_openai_model(model):
        response_object = client.chat.completions.create(
            model=model_name,
            max_tokens=max_tokens,
            messages=messages,
            temperature=temperature,
            stop=end_tag,
        )
        print(colored(f"using openai model: {model_name}", "green"))
    elif is_anthropic_model(model):
        response_object = client.messages.create(
            model=model_name,
            max_tokens=max_tokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[end_tag] if end_tag else None,
            system=system_prompt,
        )
        print(colored(f"using anthropic model: {model_name}", "green"))
    else:
        raise ValueError(f"Unsupported model: {model}")

    return response_object


def initialize_messages(model, system_prompt, user_prefix, user_request, figure_inputs):
    messages = [{"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

    if is_openai_model(model):
        messages.insert(0, {"role": "system", "content": system_prompt})

    if figure_inputs:
        image_content = create_image_message(model, figure_inputs)
        messages[-1]["content"].extend(image_content)

    messages[-1]["content"].append({"type": "text", "text": user_request})
    return messages


def create_image_message(model, figure_inputs):
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

    print(f"Using images: {colored(figure_inputs, 'green')}")

    return content


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
        new_response += f"\n{end_tag}"

    return new_response, input_tokens, output_tokens, stop_reason


def handle_openai_continuation(messages, new_response, k, end_tag):
    prefill_tokens = new_response[-k:]
    user_message = (
        f"Your response got cut off, because you only have limited response space. "
        f"Please continue writing from where you left off until the very end, "
        f"marked by {end_tag}. Avoid repetition and begin your response with:"
    )
    print("User message:", colored(user_message, "magenta"))
    print(f"### Prefill tokens: {colored(prefill_tokens, 'yellow')}")
    messages.append({"role": "user", "content": user_message + prefill_tokens})


def check_stop_conditions(stop_reason, new_response, state, output_settings, massive_repetition_detected):
    end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
    encounter_document_tag = f"</{output_settings['document_tag']}>" in new_response
    continuation_limit = state["continuation_count"] > 10
    input_token_limit = state["total_input_tokens"] > 1000000
    output_token_limit = state["total_output_tokens"] > 2.5 * state["first_input_tokens"]

    if output_token_limit:
        print("WARNING: Total output tokens exceed 2.5 times the number of the first input tokens. Halting the process.")

    should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

    return end_turn, should_stop


def print_stop_flags(end_turn, new_response, state, output_settings, massive_repetition_detected):
    print("Printing the flags")
    print(f"end_turn: {end_turn}")
    print(f"encounter_document_tag: {'</latex_document>' in new_response}")
    print(f"continuation_limit: {state['continuation_count'] > 10}")
    print(f"input_token_limit: {state['total_input_tokens'] > 100000}")
    print(f"massive_repetition_detected: {massive_repetition_detected}")
    print(f"output_token_limit: {state['total_output_tokens'] > 2.5 * state['first_input_tokens']}")
    print(f"### The last {output_settings['k']} characters of the previous response are:")
    print(colored(f"### {state['last_response'][-output_settings['k']:]}", "yellow"))
