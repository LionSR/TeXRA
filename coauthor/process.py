import os
import time
from typing import Any, Dict, List, Optional, Tuple

from .logging_utils import logger
from .file_utils import read_file, write_file
from .message_utils import (
    create_image_message,
    initialize_messages,
    extract_response_statistics,
    check_stop_conditions,
    print_stop_flags,
    handle_openai_continuation,
    has_end_tag,
)
from .openai_utils import best_connection_method
from .output_utils import check_for_massive_repetition, write_to_output_file
from .prompt_utils import render_prompt
from .model_config import ModelConfig
from .state import State
from .replacement_utils import get_all_replacements, apply_replacements
from .config import TaskConfig, AgentSettings, AgentPrompts


def process_response_cycle(
    client: Any,
    state: State,
    accumulated_output: str,
    messages,
    output_file: str,
    model_config: ModelConfig,
    task_config: TaskConfig,
    agent_settings: AgentSettings,
    agent_prompts: AgentPrompts,
):
    end_turn = False

    while not end_turn:
        file_exists = os.path.exists(output_file)
        start_time = time.time()
        response_object = model_config.create_response(
            client=client,
            messages=messages,
            temperature=task_config.temperature,
            system_prompt=agent_prompts.system_prompt,
            end_tag=agent_settings.end_tag,
        )
        response_time = time.time() - start_time
        state.update_response_time(response_time)
        logger.info(f"Response time: {response_time:.2f}s")
        new_response, input_tokens, output_tokens, stop_reason = extract_response_statistics(response_object, model_config, agent_settings.end_tag)
        logger.info(f"Stop reason: {stop_reason}")
        logger.info(f"Token usage: {response_object.usage}")

        new_response = apply_replacements(new_response, get_all_replacements())

        state.update_token_counts(
            input_tokens,
            output_tokens,
            getattr(response_object.usage, "cache_read_input_tokens", 0),
            getattr(response_object.usage, "cache_creation_input_tokens", 0),
        )

        best_connector, _ = best_connection_method(state.last_response[-task_config.K :], new_response[: task_config.K])

        massive_repetition_detected = check_for_massive_repetition(state.last_response, new_response)
        if not massive_repetition_detected:
            accumulated_output += best_connector + new_response
            file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)
            logger.debug(f"Last {task_config.K} characters of the response: {new_response[-task_config.K:]}")
            state.last_response = new_response

            if messages[-1]["role"] == "assistant":
                if model_config.supports_prompt_caching:
                    if isinstance(messages[-1]["content"], list):
                        if len(messages[-1]["content"]) >= 2 and isinstance(messages[-1]["content"][-2], dict):
                            if "cache_control" in messages[-1]["content"][-2]:
                                messages[-1]["content"][-2].pop("cache_control")
                        messages[-1]["content"].append({"type": "text", "text": best_connector + new_response, "cache_control": {"type": "ephemeral"}})
                    else:
                        messages[-1]["content"] = [{"type": "text", "text": accumulated_output, "cache_control": {"type": "ephemeral"}}]
                else:
                    messages[-1]["content"] = accumulated_output

        end_turn, should_stop = check_stop_conditions(stop_reason, new_response, state, agent_settings, massive_repetition_detected)

        if should_stop:
            print_stop_flags(end_turn, new_response, state, agent_settings, massive_repetition_detected)
            break

        state.increment_continuation()
        logger.info(f"Starting continuation #{state.continuation_count}")

        if model_config.is_openai_compatible:
            handle_openai_continuation(messages, new_response, agent_settings.end_tag, task_config.K)

    return state, accumulated_output, end_turn


def initialize_output_and_prefill(
    output_file: str,
    model_config: ModelConfig,
    task_config: TaskConfig,
    agent_settings: AgentSettings,
    agent_prompts: AgentPrompts,
    messages,
    prefill: str,
    accumulated_output: str,
    first_k_tex_document: Optional[str] = None,
):
    if os.path.exists(output_file) and os.path.getsize(output_file) > 15:
        file_content = read_file(output_file)
        if has_end_tag(file_content, agent_settings.end_tag, agent_settings.document_tag):
            logger.debug("End tag detected - skipping continuation")
            if messages[-1]["content"][-1].get("cache_control"):
                messages[-1]["content"][-1].pop("cache_control")
            messages.append({"role": "assistant", "content": file_content})
            return None, True, messages
        else:
            logger.warning("Output file exists but no end tag found - continuing from file")
            accumulated_output = file_content
            if model_config.supports_prompt_caching:
                messages.append({"role": "assistant", "content": [{"type": "text", "text": file_content, "cache_control": {"type": "ephemeral"}}]})
            else:
                messages.append({"role": "assistant", "content": file_content})
            logger.debug(f"Using existing content as prefill: {output_file}")
            if model_config.is_openai_compatible:
                handle_openai_continuation(messages, file_content, agent_settings.end_tag, agent_settings.K)
    else:
        if task_config.use_prefill_from_input and agent_settings.output_ext == "tex" and first_k_tex_document:
            prefill += first_k_tex_document
            if model_config.is_anthropic:
                accumulated_output = first_k_tex_document
            elif model_config.is_openai_compatible:
                accumulated_output = ""
                messages.append({"role": "assistant", "content": "```latex\n"})

        if model_config.is_anthropic:
            messages.append({"role": "assistant", "content": prefill})
            logger.debug(f"Anthropic prefill: {prefill}")
        elif model_config.is_openai_compatible:
            openai_prefill = f"Start your response with\n{prefill}"
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})
            logger.debug(f"OpenAI prefill: {openai_prefill}")

        if accumulated_output == "<scratchpad>" and prefill == "<scratchpad>" and model_config.is_anthropic:
            write_file(output_file, prefill)
        elif agent_settings.output_ext == "xml" and model_config.is_anthropic:
            write_file(output_file, prefill + "\n")

    return accumulated_output, False, messages


def process_first_round(
    client: Any,
    output_file: str,
    user_vars: Dict[str, str],
    state: State,
    messages: List[Dict[str, Any]],
    model_config: ModelConfig,
    task_config: TaskConfig,
    agent_settings: AgentSettings,
    agent_prompts: AgentPrompts,
    figure_inputs: Optional[List[str]] = None,
    round: int = 0,
    tex_count_stats: Optional[str] = None,
    first_k_tex_document: Optional[str] = None,
):
    """Process the first round."""
    logger.info(f"Processing round {round}")

    user_request = render_prompt(agent_prompts.user_request, user_vars)
    user_prefix = render_prompt(agent_prompts.user_prefix, user_vars)
    if tex_count_stats:
        user_prefix = f"{tex_count_stats}{user_prefix}"
    user_request = render_prompt(agent_prompts.user_request, user_vars)

    # Initialize messages
    messages = initialize_messages(
        model_config,
        agent_prompts.system_prompt,
        user_prefix,
        user_request,
        figure_inputs,
    )

    accumulated_output = None
    prefill = agent_settings.prefills[0] if agent_settings.prefills else ""

    accumulated_output = prefill
    accumulated_output, end_turn, messages = initialize_output_and_prefill(
        output_file,
        model_config,
        task_config,
        agent_settings,
        agent_prompts,
        messages,
        prefill,
        accumulated_output,
        first_k_tex_document,
    )

    if end_turn:
        return State.initialize(accumulated_output), accumulated_output, end_turn, messages

    state = State.initialize(accumulated_output)

    state, accumulated_output, end_turn = process_response_cycle(
        client,
        state,
        accumulated_output,
        messages,
        output_file,
        model_config,
        task_config,
        agent_settings,
        agent_prompts,
    )

    logger.info(f"Completed round {round}")
    return state, accumulated_output, end_turn, messages


def process_reflection_round(
    client: Any,
    output_file: str,
    user_vars: Dict[str, str],
    state: State,
    messages,
    model_config: ModelConfig,
    task_config: TaskConfig,
    agent_settings: AgentSettings,
    agent_prompts: AgentPrompts,
    figure_inputs: Optional[List[str]] = None,
    round: int = 1,
    tex_count_stats: Optional[str] = None,
    first_k_tex_document: Optional[str] = None,
):
    """Process the reflection round."""
    logger.info(f"Processing round {round}")

    user_request_reflect = render_prompt(agent_prompts.user_reflect, user_vars)
    user_message = f"{user_request_reflect}\n"

    # Add tex count stats if provided
    if tex_count_stats:
        user_message = f"{tex_count_stats}{user_message}"

    # Create a new message for the reflection round
    reflection_message = {"role": "user", "content": []}

    # Add figure inputs to the message if available
    if figure_inputs:
        print(f"Creating image message with {len(figure_inputs)} figures")
        image_content = create_image_message(model_config, figure_inputs)
        reflection_message["content"].extend(image_content)

    # Add the user message text
    if model_config.supports_prompt_caching:
        reflection_message["content"].append({"type": "text", "text": user_message})
        # Make sure the number of cache control is fewer than 4
        if isinstance(messages[-1]["content"], list):
            if len(messages[-1]["content"]) == 1:
                messages[0]["content"][-1].pop("cache_control", None)
            elif len(messages[-1]["content"]) >= 2:
                messages[-1]["content"][-2].pop("cache_control", None)
    else:
        reflection_message["content"].append({"type": "text", "text": user_message})

    messages.append(reflection_message)

    accumulated_output = None
    prefill = agent_settings.prefills[round] if len(agent_settings.prefills) > 1 else agent_settings.prefills[0]

    accumulated_output = prefill
    accumulated_output, end_turn, messages = initialize_output_and_prefill(
        output_file,
        model_config,
        task_config,
        agent_settings,
        agent_prompts,
        messages,
        prefill,
        accumulated_output,
        first_k_tex_document,
    )

    if end_turn:
        return State.initialize(accumulated_output), accumulated_output, end_turn, messages

    # Reset continuation count for reflection round while preserving other state
    state.continuation_count = 0
    state.last_response = accumulated_output

    state, accumulated_output, end_turn = process_response_cycle(
        client,
        state,
        accumulated_output,
        messages,
        output_file,
        model_config,
        task_config,
        agent_settings,
        agent_prompts,
    )

    logger.info(f"Completed round {round}")
    return state, accumulated_output, end_turn, messages
