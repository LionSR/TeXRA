import os
from .logging_utils import logger
import base64


from .img_utils import get_base64_encoded_image, process_pdf_input, page_count_pdf
from .model_config import ModelConfig
from .state import State
from .config import AgentSettings


def has_end_tag(file_content: str, end_tag: str, document_tag: str) -> bool:
    """Check if the file content contains the end tag or document tag."""
    return end_tag in file_content or f"</{document_tag}>" in file_content


def initialize_messages(model_config: ModelConfig, system_prompt: str, user_prefix: str, user_request: str, figure_inputs=None):
    """Initialize messages for the conversation."""
    messages = [{"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

    if model_config.is_openai:
        if "o1" in model_config.name:
            messages.insert(0, {"role": "user", "content": [{"type": "text", "text": system_prompt}]})
        else:
            messages.insert(0, {"role": "system", "content": system_prompt})

    if figure_inputs:
        image_content = create_image_message(model_config, figure_inputs)
        messages[-1]["content"].extend(image_content)

    if model_config.supports_prompt_caching:
        messages[-1]["content"].append({"type": "text", "text": user_request, "cache_control": {"type": "ephemeral"}})

    messages[-1]["content"].append({"type": "text", "text": user_request})

    return messages


def create_image_message(model_config: ModelConfig, figure_inputs):
    """Create image messages for the conversation."""
    image_contents = []
    added_figures = []

    if not isinstance(figure_inputs, list):
        figure_inputs = [figure_inputs]

    figure_inputs = [str(fig) for fig in figure_inputs]

    for figure_input in figure_inputs:
        if not os.path.exists(figure_input) or os.path.getsize(figure_input) == 0:
            logger.error(f"File not found or empty: {figure_input}")
            continue

        _, file_extension = os.path.splitext(figure_input)
        img_data, media_type = _process_image_file(figure_input, file_extension, model_config)
        logger.debug(f"Processed image: {figure_input}, type: {media_type}")
        logger.debug(f"length of img_data: {len(img_data)}")
        if img_data is not None:
            _add_image_content(image_contents, added_figures, figure_input, img_data, media_type)
        else:
            logger.error(f"Failed to process {figure_input}")

    content = _create_image_content(image_contents, model_config)

    logger.info(f"Using images: {figure_inputs}")
    logger.info(f"Successfully added: {added_figures}")

    return content


def _process_image_file(figure_input: str, file_extension: str, model_config: ModelConfig):
    """Process the image file and return the image data and media type."""
    if file_extension.lower() == ".pdf":
        # For PDFs, use document type for Anthropic models and convert to PNG for others
        if model_config.name in ["claude-3-5-sonnet-20241022", "sonnet++"] and page_count_pdf(figure_input) > 1:
            with open(figure_input, "rb") as f:
                img_data = base64.standard_b64encode(f.read()).decode("utf-8")
            media_type = "application/pdf"
        else:
            img_data = process_pdf_input(figure_input, is_openai_compatible=model_config.is_openai_compatible)
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


def _add_image_content(image_contents: list, added_figures: list, figure_input: str, img_data: str, media_type: str):
    """Add image content to the lists."""
    if isinstance(img_data, list):
        logger.debug(f"Adding {len(img_data)} pages to the image contents")
        for i, data in enumerate(img_data):
            image_contents.append({"file_name": f"{os.path.basename(figure_input)}_page_{i+1}", "data": data, "media_type": media_type})
        added_figures.extend([f"{figure_input}_page_{i+1}" for i in range(len(img_data))])
    else:
        logger.debug(f"Adding single page to the image contents: {figure_input}")
        image_contents.append({"file_name": os.path.basename(figure_input), "data": img_data, "media_type": media_type})
        added_figures.append(figure_input)


def _create_image_content(image_contents: list, model_config: ModelConfig):
    """Create the image content for the message."""
    content = []
    for image in image_contents:
        if model_config.is_anthropic and image["media_type"] == "application/pdf":
            content.extend(
                [
                    {"type": "text", "text": f"Document: {image['file_name']}"},
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": image["data"]}},
                ]
            )
        else:
            content.extend(
                [
                    {"type": "text", "text": f"Image: {image['file_name']}"},
                    {
                        "type": "image" if model_config.is_anthropic else "image_url",
                        "source" if model_config.is_anthropic else "image_url": {
                            "type" if model_config.is_anthropic else "url": (
                                "base64" if model_config.is_anthropic else f"data:{image['media_type']};base64,{image['data']}"
                            ),
                            "media_type": image["media_type"],
                            "data": image["data"],
                        },
                    },
                ]
            )
    return content


def extract_response_statistics(response_object, model_config: ModelConfig, end_tag: str = None):
    """Extract statistics from the response object."""
    if model_config.is_anthropic:
        return _extract_anthropic_statistics(response_object, end_tag)
    else:
        return _extract_openai_statistics(response_object, end_tag)


def _extract_openai_statistics(response_object, end_tag: str):
    """Extract statistics from OpenAI response object."""
    stop_reason = response_object.choices[0].finish_reason
    new_response = response_object.choices[0].message.content.strip()

    if response_object.usage is None:
        logger.error("No usage information in response object")
        input_tokens, output_tokens = 0, 0
    else:
        input_tokens = response_object.usage.prompt_tokens
        output_tokens = response_object.usage.completion_tokens

    if "stop" in stop_reason and "\\end{document}" not in new_response:
        new_response += f"\n{end_tag}"

    return new_response, input_tokens, output_tokens, stop_reason


def _extract_anthropic_statistics(response_object, end_tag: str):
    """Extract statistics from Anthropic response object."""
    input_tokens = response_object.usage.input_tokens
    output_tokens = response_object.usage.output_tokens
    stop_reason = response_object.stop_reason

    if output_tokens == 3:
        logger.error("No output generated - API returned empty response")
        logger.debug(f"response_object: {response_object}")
        logger.debug(f"response_object.content: {response_object.content}")
        raise ValueError("No output generated")

    if response_object.type == "error":
        logger.error("API error")
        logger.debug(f"output_tokens: {output_tokens}")
        logger.debug(f"error: {response_object.error}")
        raise ValueError("API error")

    new_response = response_object.content[0].text.strip()

    if "stop" in stop_reason and "\\end{document}" not in new_response:
        new_response += f"\n{end_tag}"

    return new_response, input_tokens, output_tokens, stop_reason


def handle_openai_continuation(messages, new_response: str, end_tag: str, K: int):
    """Handle continuation for OpenAI models."""
    prefill_tokens = new_response[-K:]
    user_message_continuation = (
        f"Your response got cut off, because you only have limited response space. "
        f"Continue writing exactly from where you left off until the very end, "
        f'marked by {end_tag}. Avoid repeat yourself and avoid starting over. Start your response at the next token after: "{prefill_tokens}"'
    )
    logger.info("User message: " + user_message_continuation)
    messages.append({"role": "user", "content": user_message_continuation})


def check_stop_conditions(
    stop_reason: str,
    new_response: str,
    state: State,
    agent_settings: AgentSettings,
    massive_repetition_detected: bool
) -> tuple[bool, bool]:
    """Check if the conversation should stop."""
    end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
    encounter_document_tag = f"</{agent_settings.document_tag}>" in new_response
    continuation_limit = state.continuation_count > 10
    input_token_limit = state.total_input_tokens > 1500000
    output_token_limit = state.total_output_tokens > 2.5 * state.first_input_tokens

    if output_token_limit:
        logger.error("Output tokens exceed 2.5x input tokens - halting process")

    should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

    return end_turn, should_stop


def print_stop_flags(
    end_turn: bool,
    new_response: str,
    state: State,
    agent_settings: AgentSettings,
    massive_repetition_detected: bool,
    K: int = 200
):
    """Print the flags indicating why the conversation stopped."""
    logger.debug("Printing the flags")
    logger.debug(f"end_turn: {end_turn}")
    document_tag = agent_settings.document_tag
    logger.debug(f"encounter_document_tag: {f'</{document_tag}>' in new_response}")
    logger.debug(f"continuation_limit: {state.continuation_count > 10}")
    logger.debug(f"input_token_limit: {state.total_input_tokens > 100000}")
    logger.debug(f"massive_repetition_detected: {massive_repetition_detected}")
    logger.debug(f"output_token_limit: {state.total_output_tokens > 2.5 * state.first_input_tokens}")
    logger.debug(f"{state.last_response[-K:]}")
