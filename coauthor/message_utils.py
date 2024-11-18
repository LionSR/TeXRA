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

        file_extension = os.path.splitext(figure_input)[1].lower()

        try:
            img_data, media_type = _process_image_file(figure_input, file_extension, model_config)
            logger.debug(f"Processed image: {figure_input}, type: {media_type}")
            logger.debug(f"length of img_data: {len(img_data)}")
            _add_image_content(image_contents, added_figures, figure_input, img_data, media_type)
        except Exception as e:
            logger.error(f"Failed to process image {figure_input}: {e}")
            continue
    
    logger.info(f"Using images: {figure_inputs}")
    logger.info(f"Successfully added: {added_figures}")

    return model_config.create_image_content(image_contents)


def _process_image_file(figure_input: str, file_extension: str, model_config: ModelConfig):
    """Process the image file and return the image data and media type."""
    if file_extension.lower() == ".pdf":
        # For PDFs, use native PDF support for latest Anthropic models and convert to PNG for others
        if model_config.supports_native_pdf and page_count_pdf(figure_input) > 1:
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
    stop_reason: str, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool
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


def print_stop_flags(end_turn: bool, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool, K: int = 200):
    """Print the flags indicating why the conversation stopped."""
    logger.debug(
        f"end_turn: {end_turn}, "
        f"end_tag: {agent_settings.end_tag in new_response}, "
        f"has_end_tag: {has_end_tag(new_response, agent_settings.end_tag, agent_settings.document_tag)}, "
        f"continuation_limit: {state.continuation_count > 10}, "
        f"input_token_limit: {state.total_input_tokens > 100000}, "
        f"len(new_response): {len(new_response)}, "
        f"massive_repetition_detected: {massive_repetition_detected}, "
        f"output_token_limit: {state.total_output_tokens > 2.5 * state.first_input_tokens}, "
        f"{state.last_response[-K:]}"
    )
