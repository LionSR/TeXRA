import os
import time
from anthropic import Anthropic
from termcolor import colored

from .utils import (
    read_file,
    write_file,
    check_for_massive_repetition,
)
from .claude_utils import compute_anthropic_price, model_mapping
from .openai_utils import best_connection_method


def load_system_prompt(task, prompt_path):
    system_prompt_file = os.path.join(prompt_path, f"system_prompt_{task}.txt")
    return read_file(system_prompt_file)


def process_file_with_claude(
    task,
    task_settings,
    input_file,
    user_prefix_input_vars,
    reflect=False,
    model="sonnet",
    api_key=None,
    prompt_path=None,
):
    model_name = model_mapping[model]

    ANTHROPIC_API_KEY = api_key or os.getenv("ANTHROPIC_API_KEY")
    client = Anthropic(api_key=ANTHROPIC_API_KEY)
    output_type = task_settings["output_type"]

    file_name, _ = os.path.splitext(input_file)

    first_task_chunk = task.split("_")[0]
    output_file = f"{file_name}_{first_task_chunk}_{model}.{output_type}"

    if prompt_path is None:
        prompt_path = os.getenv("PROMPT_PATH", "prompts")

    user_prefix_input_file_path = os.path.join(prompt_path, f"user_prefix_{task}.txt")
    user_prefix_input_template = read_file(user_prefix_input_file_path)
    user_request_file_path = os.path.join(prompt_path, f"user_request_{task}.txt")
    user_request = read_file(user_request_file_path)

    user_prefix_input = user_prefix_input_template.format(**user_prefix_input_vars)

    print(
        "User prompt prefix template:",
        colored(user_prefix_input_template, "magenta"),
        "\n",
    )
    print("User prompt request:", colored(user_request, "magenta"), "\n")

    system_prompt = load_system_prompt(task, prompt_path)
    messages = [{"role": "user", "content": user_prefix_input + user_request}]

    document_tag = task_settings["document_tag"]
    end_tag = task_settings.get("end_tag", None)

    if output_type == "tex":
        assistant_prefill_first = read_file(input_file).strip()[:50]
    else:
        assistant_prefill_first = task_settings["first_prefill"]
    accumulated_output = assistant_prefill_first

    print(f"assistant_prefill_first: {colored(assistant_prefill_first, 'yellow')}")
    messages.append({"role": "assistant", "content": assistant_prefill_first})

    state = {
        "continuation_count": 0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_response_time": 0,
        "last_response": "",
        "first_input_tokens": 0,
    }

    def process_response_cycle(state, accumulated_output, k=60):
        end_turn = False

        while True:
            start_time = time.time()

            response_object = client.messages.create(
                model=model_name,
                max_tokens=4096,
                messages=messages,
                temperature=0,
                stop_sequences=[end_tag] if end_tag else None,
                system=system_prompt,
            )

            end_time = time.time()
            response_time = end_time - start_time
            state["total_response_time"] += response_time
            print(f"### Response time: {colored(response_time, 'green')} seconds")
            print(f"### Reason for stopping: {response_object.stop_reason}")
            print(f"### Usage: {colored(response_object.usage, 'cyan')}")

            if response_object.type == "error":
                print("Error from the Anthropic API:")
                print(f"### DEBUG output_tokens: {response_object.usage.output_tokens}")
                print(f"### DEBUG error: {response_object.error}")
                break

            if response_object.usage.output_tokens == 3:
                print("Some errors might have appeared")
                print(f"### DEBUG response_object: {response_object}")
                print(f"### DEBUG response_object.content: {response_object.content}")
                break
            else:
                new_response = response_object.content[0].text.strip()

            if state["continuation_count"] == 0:
                state["first_input_tokens"] = response_object.usage.input_tokens

            state["total_input_tokens"] += response_object.usage.input_tokens
            state["total_output_tokens"] += response_object.usage.output_tokens

            # Print the last k characters of the previous response and the first k characters of the new response
            if state["continuation_count"] > 0:
                print(
                    "### The last {} characters of the previous response are:".format(k)
                )
                print(colored(f"### {state['last_response'][-k:]}", "yellow"))
                print("### The first {} characters of the new response are:".format(k))
                print(colored(f"### {new_response[:k]}", "yellow"))

            if state["continuation_count"] > 0:
                # accumulated_output += " " + new_response

                # Use the last k characters of the previous response and the first k characters of the new response
                str1 = state["last_response"][-k:]
                str2 = new_response[:k]

                # Call the best_connection_method function from openai_utils.py
                choice = best_connection_method(str1, str2)

                if choice == "A":
                    accumulated_output += new_response
                elif choice == "B":
                    accumulated_output += " " + new_response
                elif choice == "C":
                    accumulated_output += "\n" + new_response
                else:
                    print(f"Invalid choice: {choice}. Defaulting to adding a space.")
                    accumulated_output += " " + new_response

            else:
                accumulated_output += new_response

            if response_object.stop_reason == "stop_sequence":
                accumulated_output += "\n\n" + end_tag

            write_file(output_file, accumulated_output + "\n")

            print(
                f"### Last {k} characters of the response: {colored(new_response[-k:], 'yellow')}"
            )

            messages[-1] = {"role": "assistant", "content": new_response}

            # Check for massive repetition using difflib
            massive_repetition_detected = check_for_massive_repetition(
                state["last_response"], new_response
            )

            state["last_response"] = new_response

            # Define boolean variables for each stopping reason
            end_turn = response_object.stop_reason in ["end_turn", "stop_sequence"]
            encounter_document_tag = f"</{document_tag}>" in new_response
            continuation_limit = state["continuation_count"] > 10
            input_token_limit = response_object.usage.input_tokens > 100000
            massive_repetition = massive_repetition_detected

            # Check if the total output tokens exceed 1.3 times the first input tokens
            output_token_limit = (
                state["total_output_tokens"] > 1.3 * state["first_input_tokens"]
            )

            # Print warning messages for certain stopping reasons
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
                print("Printing the flags\n")
                print(f"end_turn: {end_turn}\n")
                print(f"encounter_document_tag: {encounter_document_tag}\n")
                print(f"continuation_limit: {continuation_limit}\n")
                print(f"input_token_limit: {input_token_limit}\n")
                print(f"massive_repetition: {massive_repetition}\n")
                print(f"output_token_limit: {output_token_limit}\n")
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

            # Prefill the last k tokens from the response content
            prefill_tokens = new_response[-k:]
            print(f"### Prefill tokens: {colored(prefill_tokens, 'yellow')}")
            messages.append({"role": "assistant", "content": prefill_tokens})

        return end_turn, state, accumulated_output

    end_turn, state, accumulated_output = process_response_cycle(
        state, accumulated_output
    )
    print(f"\n\nProcessed {input_file} and saved as {output_file}")

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
        messages.append({"role": "assistant", "content": assistant_prefill_first})
        accumulated_output = assistant_prefill_first
        state["last_response"] = ""
        state["continuation_count"] = 0

        end_turn, state, accumulated_output = process_response_cycle(
            state, accumulated_output
        )
        print(f"\n\nProcessed {input_file} and saved as {output_file}")

    total_input_tokens = state["total_input_tokens"]
    total_output_tokens = state["total_output_tokens"]
    total_response_time = state["total_response_time"]

    print(
        f"Total input tokens  : {colored(total_input_tokens, 'cyan')}\n"
        f"Total output tokens : {colored(total_output_tokens, 'cyan')}\n"
        f"Total response time : {colored(total_response_time, 'green')} seconds\n"
        f"Total cost          : ${compute_anthropic_price(total_input_tokens, total_output_tokens, model):.2f}"
    )

    return state, accumulated_output
