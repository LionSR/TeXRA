import os
import time
from termcolor import colored

from .file_utils import (
    read_file,
    write_file,
    append_file,
    check_for_massive_repetition,
)
from .model_utils import (
    get_model_client,
    is_openai_model,
    is_anthropic_model,
    handle_prefill,
    create_response,
    extract_response_statistics,
    print_message_summary,
)
from .img_utils import get_base64_encoded_image, single_page_pdf_to_png
from .openai_utils import best_connection_method


def load_prompt(prompt_type, task, prompt_path, task_settings):
    prompt_file = task_settings.get(f"{prompt_type}_file")
    if prompt_file:
        prompt_file_path = os.path.join(prompt_path, prompt_file)
    else:
        prompt_file_path = os.path.join(prompt_path, f"{prompt_type}_{task}.txt")
    return read_file(prompt_file_path).strip()


def process_file_with_llm(
    task,
    task_settings,
    input_file,
    user_prefix_vars,
    reflect=False,
    model="sonnet+",
    api_key=None,
    prompt_path=None,
    use_prefill_from_input=True,
    append_mode=False,
    overwrite=False,
    k=200,
    max_tokens=4096,
    temperature=0,
    figure_input=None,
):
    client, model_name = get_model_client(model, api_key)

    system_prompt = load_prompt("system_prompt", task, prompt_path, task_settings)
    user_prefix_template = load_prompt("user_prefix", task, prompt_path, task_settings)
    user_request = load_prompt("user_request", task, prompt_path, task_settings)

    user_prefix = user_prefix_template.format(**user_prefix_vars)

    print("System prompt:", colored(system_prompt, "magenta"), "\n")

    print(
        "User prompt prefix template:",
        colored(user_prefix_template, "magenta"),
        "\n",
    )
    print("User prompt request:", colored(user_request, "magenta"), "\n")

    output_type = task_settings.get("output_type", "txt")
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    print(f"Output file: {colored(output_file, 'cyan')}")

    # messages = [{"role": "user", "content": user_prefix + user_request}]
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_prefix},
                {"type": "text", "text": user_request},
            ],
        }
    ]
    if is_openai_model(model):
        messages.insert(0, {"role": "system", "content": system_prompt})

        # Handle image input
    if figure_input:
        print(f"Figure input: {colored(figure_input, 'cyan')}")
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
            }.get(file_extension, "image/jpeg")

        if is_anthropic_model(model):
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"{user_prefix}"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": img_data,
                            },
                        },
                        {"type": "text", "text": f"{user_request}"},
                    ],
                }
            ]
        elif is_openai_model(model):
            base64_image = img_data
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"{user_prefix}"},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{media_type};base64,{base64_image}"},
                        },
                        {"type": "text", "text": f"{user_request}"},
                    ],
                }
            ]

    document_tag = task_settings.get("document_tag", None)
    end_tag = task_settings.get("end_tag", None)

    assistant_prefill_first = task_settings.get("first_prefill", None)
    accumulated_output, messages, overwrite = handle_prefill(
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
    )

    state = {
        "continuation_count": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_response_time": 0,
        "last_response": accumulated_output,
        "first_input_tokens": 0,
    }

    model_settings = {
        "client": client,
        "model": model,
        "model_name": model_name,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "end_tag": end_tag,
        "system_prompt": system_prompt,
    }

    output_settings = {
        "k": k,
        "best_connector": " ",
        "overwrite": overwrite,
        "append_mode": append_mode,
        "document_tag": document_tag,
    }

    state, accumulated_output, end_turn = process_response_cycle(
        state,
        accumulated_output,
        messages,
        output_file,
        model_settings=model_settings,
        output_settings=output_settings,
    )
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

    print_message_summary(state, model)

    return state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings


def process_reflection(
    task,
    task_settings,
    input_file,
    output_file,
    state,
    accumulated_output,
    messages,
    model_settings,
    output_settings,
    prompt_path,
    use_prefill_from_input,
):
    print("\n\n", colored("### Reflection round started.", "blue"), "\n\n")

    assistant_reflect_prefill_first = task_settings.get("first_prefill_reflect", task_settings.get("first_prefill"))
    user_request_reflect = load_prompt("user_reflect", task, prompt_path, task_settings)
    print(f"User prompt reflect: {colored(user_request_reflect, 'magenta')}")

    user_message = f"{user_request_reflect}\n"
    output_file_reflect = output_file.replace(
        f"_{model_settings['model']}.{output_settings['document_tag']}", f"_reflect_{model_settings['model']}.{output_settings['document_tag']}"
    )
    messages.append({"role": "user", "content": user_message})

    if output_settings["document_tag"] == "tex" and use_prefill_from_input:
        first_k_tex_document = read_file(input_file)[: output_settings["k"]].strip()
        accumulated_output = first_k_tex_document
    else:
        accumulated_output = assistant_reflect_prefill_first

    messages.append({"role": "assistant", "content": assistant_reflect_prefill_first})
    print(f"assistant_reflect_prefill_first: {colored(assistant_reflect_prefill_first, 'yellow')}")

    state["last_response"] = accumulated_output
    state["continuation_count"] = 0

    state, accumulated_output, end_turn = process_response_cycle(
        state,
        accumulated_output,
        messages,
        output_file_reflect,
        model_settings=model_settings,
        output_settings=output_settings,
    )
    print(f"\n\nProcessed {input_file} and saved as {output_file_reflect}")

    print_message_summary(state, model_settings["model"])

    return state, accumulated_output, end_turn, output_file_reflect, messages


def process_response_cycle(
    state,
    accumulated_output,
    messages,
    output_file,
    model_settings=None,
    output_settings=None,
):
    end_turn = False

    k = output_settings["k"]

    file_exists = os.path.exists(output_file)

    while not end_turn:
        start_time = time.time()
        response_object = create_response(
            client=model_settings["client"],
            messages=messages,
            model_settings=model_settings,
        )
        response_time = time.time() - start_time
        state["total_response_time"] += response_time
        print(f"### Response time: {colored(response_time, 'green')} seconds")

        (
            new_response,
            input_tokens,
            output_tokens,
            stop_reason,
        ) = extract_response_statistics(response_object, model_settings["model"], model_settings["end_tag"])

        print(f"### Reason for stopping: {stop_reason}")
        print(f"### Usage: {colored(response_object.usage, 'cyan')}")

        state["total_input_tokens"] += input_tokens
        state["total_output_tokens"] += output_tokens
        if state["continuation_count"] == 0:
            state["first_input_tokens"] = input_tokens

        if state["continuation_count"] > 0:
            print("### The last {} characters of the previous response are:".format(k))
            print(colored(f"### {state['last_response'][-k:]}", "yellow"))
            print("### The first {} characters of the new response are:".format(k))
            print(colored(f"### {new_response[:k]}", "yellow"))

        best_connector, _ = best_connection_method(
            state["last_response"][-k:],
            new_response[:k],
        )

        accumulated_output += best_connector + new_response

        if not file_exists:
            # or not output_settings["append_mode"]
            print("Creating the file")
            write_file(output_file, new_response)
            file_exists = True
        elif output_settings["overwrite"]:
            print("Overwriting file")
            write_file(output_file, new_response)
            output_settings["overwrite"] = False
        else:
            print("Appending to file")
            append_file(output_file, best_connector + new_response)

        print(f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}")

        # the previous continue logic (see below)
        # messages[-1] = {"role": "assistant", "content": new_response}

        # maybe
        # messages.append({"role": "assistant", "content": new_response})
        if messages[-1]["role"] == "assistant":
            messages[-1]["content"] = accumulated_output

        massive_repetition_detected = check_for_massive_repetition(state["last_response"], new_response)

        state["last_response"] = new_response

        end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
        encounter_document_tag = f"</{output_settings['document_tag']}>" in new_response
        continuation_limit = state["continuation_count"] > 10
        input_token_limit = input_tokens > 100000

        output_token_limit = state["total_output_tokens"] > 2.5 * state["first_input_tokens"]  # should be 1.3 for translation/transcribe tasks

        if output_token_limit:
            print("WARNING: Total output tokens exceed 2.5 times the number of the first input tokens. Halting the process.")
        if continuation_limit:
            print("Stopping after 10 continuations or 100,000 input tokens")

        should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

        if should_stop:
            print("Printing the flags")
            print(f"end_turn: {end_turn}")
            print(f"encounter_document_tag: {encounter_document_tag}")
            print(f"continuation_limit: {continuation_limit}")
            print(f"input_token_limit: {input_token_limit}")
            print(f"massive_repetition_detected: {massive_repetition_detected}")
            print(f"output_token_limit: {output_token_limit}")
            print("### The last {} characters of the previous response are:".format(k))
            print(colored(f"### {state['last_response'][-k:]}", "yellow"))
            break

        state["continuation_count"] += 1
        print(f"\nContinuation #{state['continuation_count']}")

        # does this apply to openai models or only anthropic models?
        if is_openai_model(model_settings["model"]):
            prefill_tokens = new_response[-k:]
            user_message = (
                f"Your response got cut off, because you only have limited response space. "
                f"Please continue writing from where you left off until the very end, "
                f"marked by {model_settings['end_tag']}. Avoid repetition and begin your response with:"
            )
            print("User message:", colored(user_message, "magenta"))
            print(f"### Prefill tokens: {colored(prefill_tokens, 'yellow')}")
            messages.append({"role": "user", "content": user_message + prefill_tokens})

            # previous version: which somehow worked for gpts?
            # messages.append({"role": "user", "content": user_message})
            # messages.append({"role": "assistant", "content": prefill_tokens})

    return state, accumulated_output, end_turn
