import os
import time
from termcolor import colored

from .utils import (
    read_file,
    write_file,
    append_file,
    check_for_massive_repetition,
)
from .utils import print_summary, get_model_client, is_openai_model, is_anthropic_model
from .openai_utils import best_connection_method


def load_system_prompt(task, prompt_path):
    system_prompt_file = os.path.join(prompt_path, f"system_prompt_{task}.txt")
    return read_file(system_prompt_file).strip()


def load_user_prefix_template(task, prompt_path):
    user_prefix_template_file_path = os.path.join(prompt_path, f"user_prefix_{task}.txt")
    return read_file(user_prefix_template_file_path).strip()


def load_user_request(task, prompt_path):
    user_request_file_path = os.path.join(prompt_path, f"user_request_{task}.txt")
    return read_file(user_request_file_path).strip()


def process_file_with_llm(
    task,
    task_settings,
    input_file,
    user_prefix_vars,
    reflect=False,
    model="sonnet",
    api_key=None,
    prompt_path=None,
    k=200,
    use_prefill_from_input=True,
    max_tokens=4096,
    append_mode=False,
):
    client, model_name = get_model_client(model, api_key)

    system_prompt = load_system_prompt(task, prompt_path)
    user_prefix_template = load_user_prefix_template(task, prompt_path)
    user_request = load_user_request(task, prompt_path)
    user_prefix = user_prefix_template.format(**user_prefix_vars)
    print(
        "User prompt prefix template:",
        colored(user_prefix_template, "magenta"),
        "\n",
    )
    print("User prompt request:", colored(user_request, "magenta"), "\n")

    output_type = task_settings["output_type"]
    file_name, _ = os.path.splitext(input_file)
    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"
    print(f"Output file: {colored(output_file, 'cyan')}")

    messages = [{"role": "user", "content": user_prefix + user_request}]
    if is_openai_model(model):
        messages.insert(0, {"role": "system", "content": system_prompt})

    document_tag = task_settings["document_tag"]
    end_tag = task_settings.get("end_tag", None)

    assistant_prefill_first = task_settings["first_prefill"]
    accumulated_output = assistant_prefill_first
    if output_type == "tex" and use_prefill_from_input:
        first_k_tex_document = read_file(input_file).strip()[:k]
        assistant_prefill_first += first_k_tex_document
        accumulated_output = first_k_tex_document
        if is_openai_model(model):
            accumulated_output = ""
            messages.append({"role": "assistant", "content": "```latex"})
            # messages.append({"role": "user", "content": "continue"})

    if is_anthropic_model(model):
        if append_mode and os.path.exists(output_file):
            file_content = read_file(output_file).strip()
            accumulated_output = file_content
            messages.append({"role": "assistant", "content": file_content})
            print(
                f"Using existing file content as prefill: {colored(output_file, 'green')}"
            )
        else:
            print(
                f"assistant_prefill_first: {colored(assistant_prefill_first, 'yellow')}"
            )
            messages.append(
                {"role": "assistant", "content": assistant_prefill_first.strip()}
            )

    state = {
        "continuation_count": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_response_time": 0,
        "last_response": accumulated_output,
        "first_input_tokens": 0,
    }

    def process_response_cycle(
        state, accumulated_output, messages, k=k, best_connector=" "
    ):
        end_turn = False

        while True:
            start_time = time.time()

            if is_openai_model(model):
                response_object = client.chat.completions.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    messages=messages,
                    temperature=0,
                    stop=end_tag,
                )
                response_time = time.time() - start_time
                state["total_response_time"] += response_time
                print(f"### Response time: {colored(response_time, 'green')} seconds")
                print(
                    f"### Reason for stopping: {response_object.choices[0].finish_reason}"
                )
                print(f"### Usage: {colored(response_object.usage, 'cyan')}")
                new_response = response_object.choices[0].message.content.strip()
                input_tokens = response_object.usage.prompt_tokens
                output_tokens = response_object.usage.completion_tokens
                stop_reason = response_object.choices[0].finish_reason
                if stop_reason == "stop":
                    new_response = new_response + "\n" + end_tag
            elif is_anthropic_model(model):
                response_object = client.messages.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    messages=messages,
                    temperature=0,
                    stop_sequences=[end_tag] if end_tag else None,
                    system=system_prompt,
                )
                response_time = time.time() - start_time
                state["total_response_time"] += response_time
                print(f"### Response time: {colored(response_time, 'green')} seconds")
                print(f"### Reason for stopping: {response_object.stop_reason}")
                print(f"### Usage: {colored(response_object.usage, 'cyan')}")
                input_tokens = response_object.usage.input_tokens
                output_tokens = response_object.usage.output_tokens
                stop_reason = response_object.stop_reason
                if output_tokens == 3:
                    print("Some errors might have appeared. No output generated")
                    print(f"### DEBUG response_object: {response_object}")
                    print(
                        f"### DEBUG response_object.content: {response_object.content}"
                    )
                    break
                else:
                    new_response = response_object.content[0].text.strip()

                if response_object.type == "error":
                    print("Error from the API:")
                    print(f"### DEBUG output_tokens: {output_tokens}")
                    print(f"### DEBUG error: {response_object.error}")
                    break

                if stop_reason == "stop_sequence":
                    new_response = new_response + "\n" + end_tag

            state["total_input_tokens"] += input_tokens
            state["total_output_tokens"] += output_tokens

            if state["continuation_count"] == 0:
                state["first_input_tokens"] = input_tokens

            if state["continuation_count"] > 0:
                print(
                    "### The last {} characters of the previous response are:".format(k)
                )
                print(colored(f"### {state['last_response'][-k:]}", "yellow"))
                print("### The first {} characters of the new response are:".format(k))
                print(colored(f"### {new_response[:k]}", "yellow"))

            str1 = state["last_response"][-k:]
            str2 = new_response[:k]
            best_connector, _ = best_connection_method(str1, str2)

            accumulated_output += best_connector + new_response

            if state["continuation_count"] == 0 and not append_mode:
                write_file(output_file, accumulated_output)

            append_file(output_file, best_connector + new_response)

            print(
                f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}"
            )

            messages[-1] = {"role": "assistant", "content": new_response}

            massive_repetition_detected = check_for_massive_repetition(
                state["last_response"], new_response
            )

            state["last_response"] = new_response

            end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
            encounter_document_tag = f"</{document_tag}>" in new_response
            continuation_limit = state["continuation_count"] > 10
            input_token_limit = input_tokens > 100000
            massive_repetition = massive_repetition_detected

            output_token_limit = (
                state["total_output_tokens"] > 2.5 * state["first_input_tokens"]
            )  # should be 1.3 for translation

            if output_token_limit:
                print(
                    "WARNING: Total output tokens exceed 1.3 times the number of the first input tokens. Halting the process."
                )
            if continuation_limit:
                print("Stopping after 10 continuations or 100,000 input tokens")

            should_stop = (
                end_turn
                or encounter_document_tag
                or continuation_limit
                or input_token_limit
                or massive_repetition
                or output_token_limit
            )

            if should_stop:
                print("Printing the flags")
                print(f"end_turn: {end_turn}")
                print(f"encounter_document_tag: {encounter_document_tag}")
                print(f"continuation_limit: {continuation_limit}")
                print(f"input_token_limit: {input_token_limit}")
                print(f"massive_repetition: {massive_repetition}")
                print(f"output_token_limit: {output_token_limit}")
                print(
                    "### The last {} characters of the previous response are:".format(k)
                )
                print(colored(f"### {state['last_response'][-k:]}", "yellow"))
                break

            state["continuation_count"] += 1
            user_message = (
                f"Your response got cut off, because you only have limited response space. "
                f"Please continue writing from where you left off until the very end, "
                f"marked by {end_tag}. Avoid repetition and begin your response with:"
            )
            print(
                f"\nContinuation #{state['continuation_count']}.\nUser message:",
                colored(user_message, "magenta"),
            )

            messages.append({"role": "user", "content": user_message})

            prefill_tokens = new_response[-k:]
            print(f"### Prefill tokens: {colored(prefill_tokens, 'yellow')}")
            messages.append({"role": "assistant", "content": prefill_tokens})

        return end_turn, state, accumulated_output

    end_turn, state, accumulated_output = process_response_cycle(
        state, accumulated_output, messages
    )
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

    print_summary(state, model)

    if end_turn and reflect:
        print("\n\n", colored("### Reflection round started.", "blue"), "\n\n")
        user_request_reflect = read_file(
            os.path.join(prompt_path, f"user_reflect_{task}.txt")
        )
        print(f"User prompt reflect: {colored(user_request_reflect, 'magenta')}")
        user_message = f"{user_request_reflect}\n"
        output_file = output_file.replace(
            f"_{model}.{output_type}", f"_reflect_{model}.{output_type}"
        )
        messages.append({"role": "user", "content": user_message})

        if output_type == "tex" and use_prefill_from_input:
            accumulated_output = first_k_tex_document
        else:
            accumulated_output = assistant_prefill_first
        messages.append({"role": "assistant", "content": assistant_prefill_first})
        print(f"assistant_prefill_first: {colored(assistant_prefill_first, 'yellow')}")

        state["last_response"] = accumulated_output
        state["continuation_count"] = 0

        end_turn, state, accumulated_output = process_response_cycle(
            state, accumulated_output, messages
        )
        print(f"\n\nProcessed {input_file} and saved as {output_file}")

        print_summary(state, model)

    return state, accumulated_output
