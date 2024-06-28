import os
import time
from termcolor import colored

from .file_utils import read_file, write_file, append_file, check_for_massive_repetition
from .model_utils import is_openai_model, is_anthropic_model
from .message_utils import (
    initialize_messages,
    create_response,
    extract_response_statistics,
    check_stop_conditions,
    print_stop_flags,
    handle_openai_continuation,
    has_end_tag,
)
from .openai_utils import best_connection_method


def load_prompt(prompt_type, task, prompt_settings):
    prompt_path = prompt_settings.get("prompt_path")
    prompt_file = prompt_settings.get(f"{prompt_type}_file")
    if prompt_file:
        prompt_file_path = os.path.join(prompt_path, prompt_file)
    else:
        prompt_file_path = os.path.join(prompt_path, f"{prompt_type}_{task}.txt")

    prompt = read_file(prompt_file_path).strip()
    print(f"{prompt_type}: {colored(prompt, 'magenta')}")
    return prompt


def get_output_file_name(input_file, task, model, output_type, reflect=False):
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    if reflect:
        output_file = output_file.replace(f"_{model}", f"_reflect_{model}")

    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def write_to_output_file(file_exists, output_settings, best_connector, new_response, output_file):
    if not file_exists:
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

    return file_exists


def initialize_state(state, accumulated_output):
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
    file_exists = os.path.exists(output_file)

    while not end_turn:
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
            print("### The last {} characters of the previous response are:".format(k))
            print(colored(f"### {state['last_response'][-k:]}", "yellow"))
            print("### The first {} characters of the new response are:".format(k))
            print(colored(f"### {new_response[:k]}", "yellow"))

        best_connector, _ = best_connection_method(state["last_response"][-k:], new_response[:k])

        massive_repetition_detected = check_for_massive_repetition(state["last_response"], new_response)
        if not massive_repetition_detected:
            accumulated_output += best_connector + new_response
            file_exists = write_to_output_file(file_exists, output_settings, best_connector, new_response, output_file)
            print(f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}")
            state["last_response"] = new_response

            # for anthropic, we set the accumulated output as the prefill
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
    task,
    input_file,
    user_prefix_vars,
    model_settings,
    output_settings,
    prompt_settings,
    state=None,
    messages=None,
):
    model = model_settings["model"]
    system_prompt = load_prompt("system_prompt", task, prompt_settings)
    user_prefix_template = load_prompt("user_prefix", task, prompt_settings)
    user_request = load_prompt("user_request", task, prompt_settings)
    prompt_settings.update({"system_prompt": system_prompt})

    user_prefix = user_prefix_template.format(**user_prefix_vars)

    output_type = output_settings.get("output_type", "txt")
    output_file = get_output_file_name(input_file, task, model, output_type)

    messages = initialize_messages(model, system_prompt, user_prefix, user_request, prompt_settings["figure_inputs"])

    accumulated_output = None
    if os.path.exists(output_file):
        file_content = read_file(output_file)
        if has_end_tag(file_content, output_settings["end_tag"], output_settings["document_tag"]):
            print("### end_tag detected in the first prospect output file. Skipping continuation.")

            # here should incldue the scratchpad log from the log file too.
            log_file_name = output_file.replace(".tex", "_log.txt")
            if os.path.exists(log_file_name):
                file_content = read_file(log_file_name) + file_content
            messages.append({"role": "assistant", "content": file_content})
            return initialize_state(state, None), accumulated_output, True, output_file, messages, model_settings, output_settings, prompt_settings
        else:
            print(colored("### The first prospect output file exists but did not detect the end_tag. Continuing from the file.", "yellow"))
            accumulated_output = file_content

            messages.append({"role": "assistant", "content": file_content})
            print(f"Using existing file content as prefill: {colored(output_file, 'green')}")
            if is_openai_model(model_settings["model"]):
                handle_openai_continuation(messages, file_content, output_settings["k"], output_settings["end_tag"])
    else:
        # starting from scratch
        prefill_first = prompt_settings["prefill_first"]
        use_prefill_from_input = prompt_settings["use_prefill_from_input"]
        accumulated_output = prefill_first

        if output_type == "tex" and use_prefill_from_input:
            first_k_tex_document = read_file(input_file)[: output_settings["k"]]
            prefill_first += first_k_tex_document
            if is_anthropic_model(model):
                accumulated_output = first_k_tex_document
            elif is_openai_model(model):
                accumulated_output = ""
                messages.append({"role": "assistant", "content": "```latex\n"})

        messages.append({"role": "assistant", "content": prefill_first})

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
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

    return state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings, prompt_settings


def process_reflection_round(client, task, input_file, state, messages, model_settings, output_settings, prompt_settings, use_prefill_from_input):
    print("\n\n", colored("### Reflection round started or continued.", "blue"), "\n\n")
    model = model_settings["model"]

    user_request_reflect = load_prompt("user_reflect", task, prompt_settings)
    user_message = f"{user_request_reflect}\n"

    output_file = get_output_file_name(input_file, task, model, output_settings["output_type"], reflect=True)

    messages.append({"role": "user", "content": user_message})

    accumulated_output = None
    if os.path.exists(output_file):
        file_content = read_file(output_file)
        if has_end_tag(file_content, output_settings["end_tag"], output_settings["document_tag"]):
            print("### end_tag detected in the reflection output file. Skipping continuation.")
            messages.append({"role": "assistant", "content": file_content})
            return initialize_state(state, None), accumulated_output, True, output_file, messages
        else:
            print(colored("### The reflection output file exists but did not detect the end_tag. Continuing from the file.", "yellow"))
            accumulated_output = file_content
            messages.append({"role": "assistant", "content": file_content})
    else:
        if prompt_settings.get("first_prefill_reflect"):
            prefill_first = prompt_settings.get("first_prefill_reflect")
        else:
            prefill_first = prompt_settings.get("prefill_first")

        if output_settings["document_tag"] == "tex" and use_prefill_from_input:
            first_k_tex_document = read_file(input_file)[: output_settings["k"]]
            accumulated_output = first_k_tex_document
        else:
            accumulated_output = prefill_first

            messages.append({"role": "assistant", "content": prefill_first})
            print(f"prefill_first: {colored(prefill_first, 'yellow')}")

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
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

    return state, accumulated_output, end_turn, output_file, messages
