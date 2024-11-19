import os
import time
from typing import Any, Dict, List, Optional

from .logging_utils import logger
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
        new_response, input_tokens, output_tokens, stop_reason = model_config.extract_response_statistics(response_object, agent_settings.end_tag)
        logger.info(f"Stop reason: {stop_reason}")
        logger.info(f"Token usage: {response_object.usage}")

        new_response = apply_replacements(new_response, get_all_replacements())

        state.update_token_counts(
            input_tokens,
            output_tokens,
            getattr(response_object.usage, "cache_read_input_tokens", 0),
            getattr(response_object.usage, "cache_creation_input_tokens", 0),
        )

        best_connector, _ = best_connection_method(state.last_response[-task_config.K:], new_response[:task_config.K])

        massive_repetition_detected = check_for_massive_repetition(state.last_response, new_response)
        if not massive_repetition_detected:
            accumulated_output += best_connector + new_response
            file_exists = write_to_output_file(file_exists, best_connector, new_response, output_file)
            logger.debug(f"Last {task_config.K} characters of the response: {new_response[-task_config.K:]}")
            state.last_response = new_response

            # should be wrapped in ModelConfig as some append message functions
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

        # Check stop conditions
        end_turn, should_stop = model_config.check_stop_conditions(stop_reason, new_response, state, agent_settings, massive_repetition_detected)
        if should_stop:
            model_config.print_stop_flags(end_turn, new_response, state, agent_settings, massive_repetition_detected, task_config.K)
            break

        state.increment_continuation()
        logger.info(f"Starting continuation #{state.continuation_count}")

        # Check if we need to continue due to truncation
        if not end_turn and not model_config.has_end_tag(new_response, agent_settings.end_tag, agent_settings.document_tag):
            model_config.handle_continuation(messages, new_response, agent_settings.end_tag, task_config.K)
            continue

    return state, accumulated_output, end_turn


def process_first_round(
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
    # getting tex_count_stats and getting first_k_tex_document should go into initialize_messages function
    messages = model_config.initialize_messages(
        agent_prompts.system_prompt,
        user_prefix,
        user_request,
        figure_inputs,
    )

    accumulated_output = None
    prefill = agent_settings.prefills[0] if agent_settings.prefills else ""

    accumulated_output = prefill
    accumulated_output, end_turn, messages = model_config.initialize_output_and_prefill(
        output_file,
        task_config,
        agent_settings,
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
    if tex_count_stats:
        user_message = f"{tex_count_stats}{user_message}"

    # Create a new message for the reflection round using model-specific implementation
    # getting tex_count_stats should go into create_reflection_message function?
    messages = model_config.create_reflection_message(messages, user_message, figure_inputs)

    accumulated_output = None
    prefill = agent_settings.prefills[round] if len(agent_settings.prefills) > round else agent_settings.prefills[0]

    accumulated_output = prefill
    accumulated_output, end_turn, messages = model_config.initialize_output_and_prefill(
        output_file,
        task_config,
        agent_settings,
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
