import os
import time
from termcolor import colored, cprint

from .file_utils import read_file, write_file, append_file
from .model_utils import is_openai_model, is_anthropic_model
from .message_utils import (
    create_image_message,
    initialize_messages,
    create_response,
    extract_response_statistics,
    check_stop_conditions,
    print_stop_flags,
    handle_openai_continuation,
    has_end_tag,
)
from .openai_utils import best_connection_method
from .output_utils import check_for_massive_repetition
from .prompt_utils import load_prompt


def write_to_output_file(file_exists, best_connector, new_response, output_file):
    if not file_exists:
        print("Creating the file")
        write_file(output_file, new_response)
        file_exists = True
    else:
        print("Appending to file")
        append_file(output_file, best_connector + new_response)


def initialize_state(state: dict | None, accumulated_output):
    if state is None:
        state = {
            "continuation_count": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_response_time": 0,
            "last_response": accumulated_output,
            "first_input_tokens": 0,
        }
    else:
        for key in ["continuation_count", "total_input_tokens", "total_output_tokens", "total_response_time", "last_response", "first_input_tokens"]:
            if key not in state:
                state[key] = 0 if key != "last_response" else accumulated_output
    return state


def process_response_cycle(client, state, accumulated_output, messages, output_file, model_settings, output_settings, prompt_settings):
    end_turn = False
    k = output_settings["k"]

    while not end_turn:
        file_exists = os.path.exists(output_file)
        start_time = time.time()
        response_object = create_response(
            client=client, messages=messages, model_settings=model_settings, output_settings=output_settings, prompt_settings=prompt_settings
        )
        response_time = time.time() - start_time
        state["total_response_time"] += response_time
        print(f"### Response time: {colored(response_time, 'green')} seconds")

        new_response, input_tokens, output_tokens, stop_reason = extract_response_statistics(
            response_object, model_settings["model"], output_settings["end_tag"]
        )
        print(f"### Reason for stopping: {stop_reason}")
        print(f"### Usage: {colored(response_object.usage, 'cyan')}")

        state["total_input_tokens"] += input_tokens
        state["total_output_tokens"] += output_tokens
        if state["continuation_count"] == 0:
            state["first_input_tokens"] = input_tokens
        else:
            print(f"### The last {k} characters of the previous response are: {colored(state['last_response'][-k:], 'yellow')}")
            print(f"### The first {k} characters of the new response are: {colored(new_response[:k], 'yellow')}")

        best_connector, _ = best_connection_method(state["last_response"][-k:], new_response[:k])

        massive_repetition_detected = check_for_massive_repetition(state["last_response"], new_response)
        if not massive_repetition_detected:
            accumulated_output += best_connector + new_response
            write_to_output_file(file_exists, best_connector, new_response, output_file)
            print(f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}")
            state["last_response"] = new_response

            if messages[-1]["role"] == "assistant":
                messages[-1]["content"] = accumulated_output

        end_turn, should_stop = check_stop_conditions(stop_reason, new_response, state, output_settings, massive_repetition_detected)

        if should_stop:
            print_stop_flags(end_turn, new_response, state, output_settings, massive_repetition_detected)
            break

        state["continuation_count"] += 1
        print(f"\nContinuation #{state['continuation_count']}")

        if is_openai_model(model_settings["model"]):
            handle_openai_continuation(messages, new_response, k, output_settings["end_tag"])

    return state, accumulated_output, end_turn


def process_first_round(
    client,
    output_file,
    user_vars,
    model_settings,
    output_settings,
    prompt_settings,
    figure_inputs=None,
    state=None,
    messages=None,
    tex_count_stats="",
    first_k_tex_document=None,
):
    model = model_settings["model"]
    system_prompt = load_prompt("system", prompt_settings)
    user_prefix_template = load_prompt("user_prefix", prompt_settings)
    user_prefix = user_prefix_template.format(**user_vars)
    user_prefix += tex_count_stats
    user_request = load_prompt("user_request", prompt_settings)

    output_type = output_settings.get("output_type", "txt")

    messages = initialize_messages(model, system_prompt, user_prefix, user_request, figure_inputs)

    accumulated_output = None
    if os.path.exists(output_file):
        file_content = read_file(output_file)
        if has_end_tag(file_content, output_settings["end_tag"], output_settings["document_tag"]):
            print("### end_tag detected in the first prospect output file. Skipping continuation.")
            messages.append({"role": "assistant", "content": file_content})
            return initialize_state(state, None), accumulated_output, True, messages
        else:
            print(colored("### The first prospect output file exists but did not detect the end_tag. Continuing from the file.", "yellow"))
            accumulated_output = file_content
            messages.append({"role": "assistant", "content": file_content})
            print(f"Using existing file content as prefill: {colored(output_file, 'green')}")
            if is_openai_model(model_settings["model"]):
                handle_openai_continuation(messages, file_content, output_settings["k"], output_settings["end_tag"])
    else:
        prefill = output_settings["prefill_first"]
        use_prefill_from_input = prompt_settings["use_prefill_from_input"]
        accumulated_output = prefill

        if output_type == "tex" and use_prefill_from_input and first_k_tex_document:
            prefill += first_k_tex_document
            if is_anthropic_model(model):
                accumulated_output = first_k_tex_document
            elif is_openai_model(model):
                accumulated_output = ""
                messages.append({"role": "assistant", "content": "```latex\n"})

        if is_anthropic_model(model):
            cprint(f"model: {model}", "white", "on_blue")
            cprint(f"anthropic prefill: {prefill}", "white", "on_blue")
            messages.append({"role": "assistant", "content": prefill})
        elif is_openai_model(model):
            openai_prefill = f"Start your response with\n{prefill}"
            cprint(f"openai prefill: {openai_prefill}", "white", "on_blue")
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})

        if accumulated_output == "<scratchpad>" and prefill == "<scratchpad>" and is_anthropic_model(model):
            write_file(output_file, prefill + "\n")

    state = initialize_state(state, accumulated_output)
    state, accumulated_output, end_turn = process_response_cycle(
        client,
        state,
        accumulated_output,
        messages,
        output_file,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
    )

    return state, accumulated_output, end_turn, messages


def process_reflection_round(
    client,
    output_file,
    state,
    messages,
    model_settings,
    output_settings,
    prompt_settings,
    figure_inputs=None,
    tex_count_stats="",
    first_k_tex_document=None,
):
    print("\n\n", colored("### Reflection round started or continued.", "blue"), "\n\n")
    model = model_settings["model"]
    use_prefill_from_input = prompt_settings.get("use_prefill_from_input", False)

    user_request_reflect = load_prompt("user_reflect", prompt_settings)
    user_message = f"{user_request_reflect}\n"

    # Add tex count stats if provided
    user_message = f"{tex_count_stats}{user_message}"

    # Create a new message for the reflection round
    reflection_message = {"role": "user", "content": []}

    # Add figure inputs to the message if available
    if figure_inputs:
        print(f"Creating image message with {len(figure_inputs)} figures")
        image_content = create_image_message(model, figure_inputs)
        reflection_message["content"].extend(image_content)

    # Add the user message text
    reflection_message["content"].append({"type": "text", "text": user_message})

    # Append the reflection message to the messages list
    messages.append(reflection_message)

    accumulated_output = None
    if os.path.exists(output_file):
        file_content = read_file(output_file)
        if has_end_tag(file_content, output_settings["end_tag"], output_settings["document_tag"]):
            print("### end_tag detected in the reflection output file. Skipping continuation.")
            messages.append({"role": "assistant", "content": file_content})
            return initialize_state(state, None), accumulated_output, True, messages
        else:
            print(colored("### The reflection output file exists but did not detect the end_tag. Continuing from the file.", "yellow"))
            accumulated_output = file_content
            messages.append({"role": "assistant", "content": file_content})
            print(f"### Using existing file content as prefill: {colored(output_file, 'green')}")
            if is_openai_model(model):
                handle_openai_continuation(messages, file_content, output_settings["k"], output_settings["end_tag"])

    else:
        prefill = output_settings["prefill_reflect"]

        accumulated_output = prefill
        if output_settings["document_tag"] == "tex" and use_prefill_from_input and first_k_tex_document:
            accumulated_output = first_k_tex_document

        if is_anthropic_model(model):
            messages.append({"role": "assistant", "content": prefill})
            cprint(f"anthropic prefill: {prefill}", "white", "on_blue")
        elif is_openai_model(model):
            openai_prefill = f"Start your response with\n{prefill}"
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})
            cprint(f"openai prefill: {openai_prefill}", "white", "on_blue")

        if accumulated_output == "<scratchpad>" and prefill == "<scratchpad>" and is_anthropic_model(model):
            write_file(output_file, prefill)

    state = initialize_state(state, accumulated_output)
    state["last_response"] = accumulated_output
    state["continuation_count"] = 0

    state, accumulated_output, end_turn = process_response_cycle(
        client,
        state,
        accumulated_output,
        messages,
        output_file,
        model_settings=model_settings,
        output_settings=output_settings,
        prompt_settings=prompt_settings,
    )

    return state, accumulated_output, end_turn, messages
