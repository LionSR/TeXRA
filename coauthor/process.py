import os
import time
from termcolor import colored

from .log_utils import log_and_print_statistics, log_output_files
from .file_utils import read_file, write_file, append_file, check_for_massive_repetition
from .model_utils import get_model_client, is_openai_model, is_anthropic_model
from .message_utils import (
    handle_prefill,
    initialize_messages,
    create_response,
    extract_response_statistics,
    check_stop_conditions,
    print_stop_flags,
    handle_openai_continuation,
)
from .tex_tools import run_latexdiff
from .openai_utils import best_connection_method


def load_prompt(prompt_type, task, prompt_path, task_settings):
    prompt_file = task_settings.get(f"{prompt_type}_file")
    if prompt_file:
        prompt_file_path = os.path.join(prompt_path, prompt_file)
    else:
        prompt_file_path = os.path.join(prompt_path, f"{prompt_type}_{task}.txt")
    return read_file(prompt_file_path).strip()


def handle_output_file(file_name, task, model, output_type):
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    print(f"Output file: {colored(output_file, 'cyan')}")
    return output_file


def handle_file_output(file_exists, output_settings, best_connector, new_response, output_file):
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


def process_first_round(
    task, task_settings, input_file, user_prefix_vars, llm_settings, output_settings, state=None, accumulated_output=None, messages=None
):
    client, model_name = get_model_client(llm_settings["model"], llm_settings["api_key"])

    system_prompt = load_prompt("system_prompt", task, llm_settings["prompt_path"], task_settings)
    user_prefix_template = load_prompt("user_prefix", task, llm_settings["prompt_path"], task_settings)
    user_request = load_prompt("user_request", task, llm_settings["prompt_path"], task_settings)

    user_prefix = user_prefix_template.format(**user_prefix_vars)

    print("System prompt:", colored(system_prompt, "magenta"), "\n")
    print("User prompt prefix template:", colored(user_prefix_template, "magenta"), "\n")
    print("User prompt request:", colored(user_request, "magenta"), "\n")

    output_type = task_settings.get("output_type", "txt")
    file_name, _ = os.path.splitext(input_file)
    output_file = handle_output_file(file_name, task, llm_settings["model"], output_type)

    if messages is None:
        messages = initialize_messages(system_prompt, user_prefix, user_request, llm_settings["figure_inputs"], llm_settings["model"])

    document_tag = task_settings.get("document_tag", None)
    end_tag = task_settings.get("end_tag", None)

    assistant_prefill_first = task_settings.get("first_prefill", None)
    if accumulated_output is None:
        accumulated_output, messages, output_settings["overwrite"] = handle_prefill(
            llm_settings["model"],
            output_type,
            output_settings["use_prefill_from_input"],
            assistant_prefill_first,
            input_file,
            output_settings["k"],
            output_settings["append_mode"],
            output_file,
            messages,
            document_tag,
            output_settings["overwrite"],
        )

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
        # Ensure all necessary keys are present in the state dictionary
        for key in ["continuation_count", "total_input_tokens", "total_output_tokens", "total_response_time", "last_response", "first_input_tokens"]:
            if key not in state:
                state[key] = 0 if key != "last_response" else accumulated_output

    model_settings = {
        "client": client,
        "model": llm_settings["model"],
        "model_name": model_name,
        "max_tokens": llm_settings["max_tokens"],
        "temperature": llm_settings["temperature"],
        "end_tag": end_tag,
        "system_prompt": system_prompt,
    }

    output_settings["document_tag"] = document_tag

    state, accumulated_output, end_turn = process_response_cycle(
        state,
        accumulated_output,
        messages,
        output_file,
        model_settings=model_settings,
        output_settings=output_settings,
    )
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

    return state, accumulated_output, end_turn, output_file, messages, model_settings, output_settings


def process_reflection_round(
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
    print("\n\n", colored("### Reflection round started or continued.", "blue"), "\n\n")

    assistant_reflect_prefill_first = task_settings.get("first_prefill_reflect", task_settings.get("first_prefill"))
    user_request_reflect = load_prompt("user_reflect", task, prompt_path, task_settings)
    print(f"User prompt reflect: {colored(user_request_reflect, 'magenta')}")

    user_message = f"{user_request_reflect}\n"
    output_file_reflect = output_file.replace(f"_{model_settings['model']}", f"_reflect_{model_settings['model']}")
    print(f"output_file_reflect: {colored(output_file_reflect, 'cyan')}")
    messages.append({"role": "user", "content": user_message})

    if output_settings["document_tag"] == "tex" and use_prefill_from_input:
        first_k_tex_document = read_file(input_file)[: output_settings["k"]].strip()
        accumulated_output = first_k_tex_document
    else:
        accumulated_output = assistant_reflect_prefill_first

    messages.append({"role": "assistant", "content": assistant_reflect_prefill_first})
    print(f"assistant_reflect_prefill_first: {colored(assistant_reflect_prefill_first, 'yellow')}")

    # Ensure all necessary keys are present in the state dictionary
    if state is None:
        state = {}

    for key in ["continuation_count", "total_input_tokens", "total_output_tokens", "total_response_time", "last_response", "first_input_tokens"]:
        if key not in state:
            state[key] = 0 if key != "last_response" else accumulated_output

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

    return state, accumulated_output, end_turn, output_file_reflect, messages


def process_response_cycle(state, accumulated_output, messages, output_file, model_settings, output_settings):
    end_turn = False
    k = output_settings["k"]
    file_exists = os.path.exists(output_file)

    while not end_turn:
        start_time = time.time()
        response_object = create_response(client=model_settings["client"], messages=messages, model_settings=model_settings)
        response_time = time.time() - start_time
        state["total_response_time"] += response_time
        print(f"### Response time: {colored(response_time, 'green')} seconds")

        new_response, input_tokens, output_tokens, stop_reason = extract_response_statistics(
            response_object, model_settings["model"], model_settings["end_tag"]
        )

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

        best_connector, _ = best_connection_method(state["last_response"][-k:], new_response[:k])

        accumulated_output += best_connector + new_response

        file_exists = handle_file_output(file_exists, output_settings, best_connector, new_response, output_file)

        print(f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}")

        # for anthropic, we set the accumulated output as the prefill
        if messages[-1]["role"] == "assistant":
            messages[-1]["content"] = accumulated_output

        massive_repetition_detected = check_for_massive_repetition(state["last_response"], new_response)

        state["last_response"] = new_response

        end_turn, should_stop = check_stop_conditions(stop_reason, new_response, state, output_settings, massive_repetition_detected)

        if should_stop:
            print_stop_flags(end_turn, new_response, state, output_settings, massive_repetition_detected)
            break

        state["continuation_count"] += 1
        print(f"\nContinuation #{state['continuation_count']}")

        if is_openai_model(model_settings["model"]):
            handle_openai_continuation(messages, new_response, k, model_settings["end_tag"])

    return state, accumulated_output, end_turn


def handle_reflection(args, task_settings, state, accumulated_output, messages, model_settings, output_settings, output_file, prompt_path):
    state, accumulated_output, end_turn, output_file_reflect, messages = process_reflection_round(
        args.task,
        task_settings,
        args.input_file,
        output_file,
        state,
        accumulated_output,
        messages,
        model_settings,
        output_settings,
        prompt_path,
        use_prefill_from_input=False,
    )
    print(colored(f"Reflect mode is on. Output files: {output_file}, {output_file_reflect}", "yellow"))
    log_file_path = args.input_file.replace(".tex", "_log.txt")
    log_output_files(log_file_path, output_file_reflect)
    log_file_reflect = output_file_reflect.replace(".tex", "_log.txt")
    log_and_print_statistics(state, args.model, log_file_reflect)

    run_latexdiff(args.input_file, output_file_reflect)
    run_latexdiff(output_file, output_file_reflect, args.model)
