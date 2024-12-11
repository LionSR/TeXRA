import os
import re
import base64

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from dotenv import load_dotenv
from typing import Dict, List, Optional, Any, Tuple

from .agent_dataclass import AgentSettings, AgentConfig
from .file_utils import read_file, write_file
from .logging_utils import logger
from .output_utils import filter_monologue_tags
from .replacement_utils import apply_replacement_regex, get_replacements_by_category
from .state import State


load_dotenv()

CONFIRMATION_PROMPT_PATTERNS = [
    "Would you like me to",
    "[Would you like me",
    "Would you like me to continue?",
    "Should I proceed with",
    "Please let me know if you'd like me to proceed",
    "I will now proceed",
    "[Due to length limits,",
    "I notice that",
    "I'll start from",
    "Since this is a large document,",
    "I'll start reviewing",
    "[Note: The corrections would be applied throughout",
    "% Note: The full corrected document would be too long",
    "[Continue with corrections...]",
    "[Continue with the rest of",
    "[Continue with corrections for",
    "[Continue with the",
    "[Continue with next",
    "[Continue with Section",
    "[Continue with subsections",
    "[Continue with similar improvements",
    "[Continuing with the",
    "Shall I begin with",
    "Let me continue with",
    "Continuing from where we left off",
    "I'll continue with the next",
    "[Rest of document continues...]",
    "[Rest of the document continues",
    "[Note: At this point, I would proceed",
    # "Previous content",
    # "[Previous sections remain unchanged",
]


class ModelProvider(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    GOOGLE = "google"
    OPENROUTER = "openrouter"


@dataclass
class ModelConfig(ABC):
    name: str  # Short name (e.g., "sonnet++")
    full_name: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    provider: ModelProvider
    max_tokens: int
    input_price: float
    output_price: float
    context_window: int = 128000
    supports_prompt_caching: bool = False
    supports_reasoning: bool = False
    supports_vision: bool = True
    supports_native_pdf: bool = False
    supports_assistant_prefill: bool = False
    supports_predictive_output: bool = False
    likes_to_ask_for_confirmation: bool = False
    base_url: Optional[str] = None

    @property
    def is_anthropic(self) -> bool:
        return self.provider == ModelProvider.ANTHROPIC

    @property
    def is_openai(self) -> bool:
        return self.provider == ModelProvider.OPENAI

    @property
    def is_google(self) -> bool:
        return self.provider == ModelProvider.GOOGLE

    @property
    def is_openrouter(self) -> bool:
        return self.provider == ModelProvider.OPENROUTER

    @property
    def is_openai_compatible(self) -> bool:
        return self.is_openai or self.is_openrouter or self.is_google

    @abstractmethod
    def get_client(self):
        """Get the appropriate client for this model."""
        pass

    @abstractmethod
    def create_response(
        self,
        client: Any,
        messages: List[Dict],
        temperature: float,
        system_prompt: Optional[str] = None,
        end_tag: Optional[str] = None,
    ) -> Any:
        """Create a response using the appropriate API call for this model."""
        pass

    @abstractmethod
    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: Optional[str] = None) -> List[Dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def create_reflection_message(self, messages: List[Dict], user_message: str, figure_files=None) -> List[Dict]:
        """Create a reflection message and handle prompt caching."""
        pass

    @abstractmethod
    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for the model."""
        pass

    @abstractmethod
    def extract_response_statistics(self, response_object, end_tag: str = None) -> Tuple[str, int, int, str]:
        """Extract statistics from the response object.
        Returns: (new_response, input_tokens, output_tokens, stop_reason)
        """
        pass

    @abstractmethod
    def process_image(self, figure_file: str, file_extension: str) -> Tuple[str, str]:
        """Process an image file according to model requirements.
        Returns: (img_data, media_type)
        """
        pass

    @abstractmethod
    def handle_continuation(self, messages: List[Dict], state: State, agent_settings: AgentSettings, agent_config: AgentConfig):
        """Handle continuation for a model when response is truncated."""
        pass

    @abstractmethod
    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: List[Dict],
        prefill: str,
        accumulated_output: str,
        first_k_tex_document: Optional[str] = None,
    ) -> Tuple[str, bool, List[Dict]]:
        """Initialize output and handle prefill based on model requirements."""
        pass

    def compute_price(
        self,
        input_tokens: int,
        output_tokens: int,
        # for openai models with prompt caching support
        cache_tokens: Optional[int] = None,
        # for openai models with reasoning tokens support
        reasoning_tokens: Optional[int] = None,
        # for anthropic models with prompt caching support
        cache_creation_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
    ) -> float:
        """
        Compute the price for token usage.
        In the future this should just take response_object.usage as input.
        """
        return (input_tokens * self.input_price + output_tokens * self.output_price) / 1e6

    def check_stop_conditions(
        self, stop_reason: str, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool
    ) -> tuple[bool, bool]:
        """Check if the conversation should stop."""

        CONTINUE_LIMIT = 20 if self.likes_to_ask_for_confirmation else 10
        INPUT_TOKEN_LIMIT = 1500000
        OUTPUT_TOKEN_LIMIT_FACTOR = 2.5

        end_turn = stop_reason in ["end_turn", "stop_sequence", "stop"]
        encounter_document_tag = f"</{agent_settings.document_tag}>" in new_response
        continuation_limit = state.continuation_count > CONTINUE_LIMIT
        input_token_limit = state.total_input_tokens > INPUT_TOKEN_LIMIT
        output_token_limit = state.total_output_tokens > OUTPUT_TOKEN_LIMIT_FACTOR * state.first_input_tokens

        if output_token_limit:
            logger.error(f"Output tokens exceed {OUTPUT_TOKEN_LIMIT_FACTOR}x input tokens - halting process")

        should_stop = encounter_document_tag or continuation_limit or input_token_limit or massive_repetition_detected or output_token_limit

        return end_turn, should_stop

    def print_stop_flags(self, end_turn: bool, new_response: str, state: State, agent_settings: AgentSettings, massive_repetition_detected: bool):
        """Print the flags indicating why the conversation stopped."""

        CONTINUE_LIMIT = 20 if self.likes_to_ask_for_confirmation else 10
        INPUT_TOKEN_LIMIT = 100000
        OUTPUT_TOKEN_LIMIT_FACTOR = 2.5

        logger.debug(
            f"Stop flags:\n"
            f"end_turn: {end_turn}\n"
            f"encounter_document_tag: {'</'+agent_settings.document_tag+'>' in new_response}\n"
            f"continuation_limit: {state.continuation_count > CONTINUE_LIMIT}\n"
            f"input_token_limit: {state.total_input_tokens > INPUT_TOKEN_LIMIT}\n"
            f"massive_repetition_detected: {massive_repetition_detected}\n"
            f"output_token_limit: {state.total_output_tokens > OUTPUT_TOKEN_LIMIT_FACTOR * state.first_input_tokens}\n"
        )

    def create_image_message(self, figure_files):
        """Create image messages for the conversation."""
        image_contents = []
        added_figures = []

        for figure_file in figure_files:
            if not os.path.exists(figure_file) or os.path.getsize(figure_file) == 0:
                logger.error(f"File not found or empty: {figure_file}")
                continue

            file_extension = os.path.splitext(figure_file)[1].lower()

            try:
                # Use model-specific image processing
                img_data, media_type = self.process_image(figure_file, file_extension)
                logger.debug(f"Processed image: {figure_file}, type: {media_type}")
                logger.debug(f"length of img_data: {len(img_data)}")

                # Handle multi-page PDFs
                if isinstance(img_data, list):
                    logger.debug(f"Adding {len(img_data)} pages to the image contents")
                    for i, data in enumerate(img_data):
                        image_contents.append({"file_name": f"{os.path.basename(figure_file)}_page_{i+1}", "data": data, "media_type": media_type})
                    added_figures.extend([f"{figure_file}_page_{i+1}" for i in range(len(img_data))])
                else:
                    logger.debug(f"Adding single page to the image contents: {figure_file}")
                    image_contents.append({"file_name": os.path.basename(figure_file), "data": img_data, "media_type": media_type})
                    added_figures.append(figure_file)
            except Exception as e:
                logger.error(f"Failed to process image {figure_file}: {e}")
                continue

        logger.info(f"Using images: {figure_files}")
        logger.info(f"Successfully added: {added_figures}")

        return self.create_image_content(image_contents)


@dataclass
class AnthropicModelConfig(ModelConfig):
    def get_client(self):
        from anthropic import Anthropic

        return Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    def create_response(
        self,
        client: Any,
        messages: List[Dict],
        temperature: float,
        system_prompt: Optional[str] = None,
        end_tag: Optional[str] = None,
    ) -> Any:
        extra_headers = []
        if self.supports_prompt_caching:
            extra_headers.append("prompt-caching-2024-07-31")
        if self.supports_native_pdf:
            extra_headers.append("pdfs-2024-09-25")

        return client.beta.messages.create(
            model=self.full_name,
            max_tokens=self.max_tokens,
            messages=messages,
            temperature=temperature,
            stop_sequences=[end_tag] if end_tag else None,
            system=system_prompt,
            betas=extra_headers if extra_headers else None,
        )

    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: Optional[str] = None) -> List[Dict]:
        """Initialize messages for the conversation."""
        messages = [{"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

        if figure_files:
            image_content = self.create_image_message(figure_files)
            messages[-1]["content"].extend(image_content)

        if self.supports_prompt_caching:
            messages[-1]["content"].append({"type": "text", "text": user_request, "cache_control": {"type": "ephemeral"}})
        else:
            messages[-1]["content"].append({"type": "text", "text": user_request})

        return messages

    def create_reflection_message(self, messages: List[Dict], user_message: str, figure_files=None) -> List[Dict]:
        """Create a reflection message for Anthropic models."""
        reflection_message = {"role": "user", "content": []}

        if figure_files:
            image_content = self.create_image_message(figure_files)
            reflection_message["content"].extend(image_content)

        if self.supports_prompt_caching:
            # A better and more maintainable way is required for managing cache control.
            reflection_message["content"].append({"type": "text", "text": user_message, "cache_control": {"type": "ephemeral"}})
            # Make sure the number of cache control is fewer than 4 for Anthropic models
            if isinstance(messages[-1]["content"], list):
                if len(messages[-1]["content"]) == 1:
                    messages[0]["content"][-1].pop("cache_control", None)
                elif len(messages[-1]["content"]) >= 2:
                    messages[-1]["content"][-2].pop("cache_control", None)
        else:
            reflection_message["content"].append({"type": "text", "text": user_message})

        messages.append(reflection_message)
        return messages

    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for Anthropic models."""
        content = []
        for image in image_contents:
            if self.supports_native_pdf and image["media_type"] == "application/pdf":
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
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image["media_type"],
                                "data": image["data"],
                            },
                        },
                    ]
                )
        return content

    def extract_response_statistics(self, response_object, end_tag: str = None) -> Tuple[str, int, int, str]:
        """
        Extract statistics from Anthropic response object.
        stop_reason: The reason that we stopped. This may be one the following values:
        - "end_turn": the model reached a natural stopping point
        - "max_tokens": we exceeded the requested max_tokens or the model's maximum
        - "stop_sequence": the model reached a stop sequence
        - "tool_use": the model invoked one or more tools
        and we also use a customized stop reason:
        - "ask_for_confirmation": the model asked for confirmation
        """

        # this function needs to be split
        # one part for statistics
        # one part for response extraction

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

        # Process each line to wrap confirmation prompts in monologue tags
        lines = new_response.split("\n")
        for i, line in enumerate(lines):
            line = line.strip()
            # Skip if line is already wrapped in monologue tags
            if line.startswith("<monologue>") and line.endswith("</monologue>"):
                continue
            # Check if line contains confirmation prompt
            if any(pattern in line for pattern in CONFIRMATION_PROMPT_PATTERNS):
                stop_reason = "ask_for_confirmation"
                if lines[i - 1].strip() == "<monologue>" and lines[i + 1].strip() == "</monologue>":
                    pass
                else:
                    lines[i] = f"<monologue>{line}</monologue>"

        new_response = "\n".join(lines)

        if "<output>" in new_response:
            # logic for when the model likes to ask for confirmation
            logger.warning("Output tag detected - extracting latex code from <output> tags")
            # new_response = extract what is inside <output> ... </output>
            match = re.search(r"<output>(.*?)</output>", new_response, re.DOTALL)
            if match:
                new_response = match.group(1)
            else:
                logger.warning("No <output> tags found in response")

        # Only append end_tag if it's a stop sequence and not a confirmation prompt
        # maybe in some cases, we need to use \\end{document} instead of end_tag
        if stop_reason == "stop_sequence" and f"{end_tag}" not in new_response:
            logger.warning(f"Stop reason: {stop_reason}. Appending {end_tag} to the response.")
            new_response += f"\n{end_tag}"

        # in the future let us just return response_object.usage
        return new_response, input_tokens, output_tokens, stop_reason

    def process_image(self, figure_file: str, file_extension: str) -> Tuple[str, str]:
        """Process image for Anthropic models."""
        if file_extension.lower() == ".pdf":
            from .img_utils import page_count_pdf, process_pdf_input

            # For PDFs, use native PDF support if available and multi-page
            if self.supports_native_pdf and page_count_pdf(figure_file) > 1:
                with open(figure_file, "rb") as f:
                    img_data = base64.b64encode(f.read()).decode("utf-8")
                media_type = "application/pdf"
            else:
                img_data = process_pdf_input(figure_file)
                media_type = "image/png"
        else:
            with open(figure_file, "rb") as f:
                img_data = base64.b64encode(f.read()).decode("utf-8")
            media_type = "image/png" if file_extension.lower() in [".png", ".jpg", ".jpeg"] else "application/octet-stream"
        return img_data, media_type

    def handle_continuation(self, messages: List[Dict], state: State, agent_settings: AgentSettings, agent_config: AgentConfig):
        """
        Anthropic models before sonnet++/haiku+ don't need continuation handling.
        However, for sonnet++/haiku+ we need to handle the continuation because they have been hard-coded to ask for confirmation.
        """
        if self.likes_to_ask_for_confirmation:
            logger.warning("Handling model_config.likes_to_ask_for_confirmation")

            # there should be a state variable including accumulated output
            if state.continuation_count <= 1:
                user_message_continuation = (
                    "Proceed. "
                    "If no previous revised output of the document is provided, "
                    "please start from the very beginning of the document and work through the full document systematically. "
                    "Note that you have an effectively infinite token response limit"
                    "because the system that you are part of handles continuations automatically. Therefore, just output the complete document."
                    f"The total number of tokens you output in the last turn is {state.output_tokens},"
                    "but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn."
                    # "Output as much as possible in each turn. Maximizing the output length is preferred."
                    "Respond the latex code of the next section in the <output> ... </output> tags."
                )
                # set a document_tag started flag?
            else:
                user_message_continuation = (
                    "Proceed to write fully the next part/section (not just a subsection, which is not enough). "
                    # "Continue writing exactly from where you left off until the end of the document. "
                    "Continue writing exactly from where you left off until the whole document has been systematically revised. "
                    # "Output as much as possible in each turn."
                    "Aim for double the length of output as previous turns. "
                    "Remember to stay professional and write latex code all the time. "
                    "Note that you have an effectively infinite token response limit"
                    "because the system that you are part of handles continuations automatically. Therefore, just output the complete document."
                    # f"Only output the end tag {end_tag} when you have finished processing the whole document until the last section."
                    f"The total number of tokens you output in the last turn is {state.output_tokens},"
                    "but the maximal token limit is 8192. Therefore, you are encouraged to maximize the output length in the next turn."
                    "Respond the latex code of the next section in the <output> ... </output> tags."
                )
                # this should also consider what if continue from existing output of a document
                document_tag_start_string = f"<{agent_settings.document_tag}>"
                first_lines = state.last_response.split("\n")[:10]
                for line in first_lines:
                    if line.strip().startswith(document_tag_start_string):
                        logger.warning(f"Removing document tag prefix {document_tag_start_string} from response")
                        state.last_response = state.last_response.replace(line, "", 1).strip()
                        break

            logger.info("User message: " + user_message_continuation)

            state.last_response = filter_monologue_tags(state.last_response)

            # solution 1: keep updating the last assistant message
            if messages[-1]["role"] == "user":
                if messages[-2]["role"] == "assistant":
                    logger.warning("Appending new response to the previous assistant message")
                    if isinstance(messages[-2]["content"], list):
                        messages[-2]["content"].append({"type": "text", "text": "\n" + state.last_response})
                    elif isinstance(messages[-2]["content"], str):
                        messages[-2]["content"] += "\n" + state.last_response
                messages[-1]["content"] = user_message_continuation
            elif messages[-1]["role"] == "assistant":
                messages.append({"role": "user", "content": user_message_continuation})

            # solution 2: keep alternating between user and assistant messages
            # seems to be working poorly
            # if messages[-1]["role"] == "user":
            #     messages.append({"role": "assistant", "content": state.last_response})
            #     messages.append({"role": "user", "content": user_message_continuation})
            # elif messages[-1]["role"] == "assistant":
            #     if isinstance(messages[-2]["content"], list):
            #         messages[-1]["content"].append({"type": "text", "text": "\n" + state.last_response})
            #     elif isinstance(messages[-2]["content"], str):
            #         messages[-2]["content"] += "\n" + state.last_response
            #     messages.append({"role": "user", "content": user_message_continuation})

            # are there any prompt caching issues here?
        else:
            pass

    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: List[Dict],
        prefill: str,
        accumulated_output: str,
        first_k_tex_document: Optional[str] = None,
    ) -> Tuple[str, bool, List[Dict]]:
        """Initialize output and handle prefill for Anthropic models."""
        if os.path.exists(output_file) and os.path.getsize(output_file) > 15:
            # try to get prefill from existing file
            file_content = read_file(output_file)

            file_content = filter_monologue_tags(file_content).strip()
            file_content = apply_replacement_regex(file_content, get_replacements_by_category("lazy"), flags=re.DOTALL | re.MULTILINE)

            if agent_settings.has_end_tag(file_content):
                logger.debug("End tag detected - skipping continuation")
                if messages[-1]["content"][-1].get("cache_control"):
                    messages[-1]["content"][-1].pop("cache_control")
                messages.append({"role": "assistant", "content": file_content})
                return None, True, messages
            else:
                logger.warning("Output file exists but no end tag found - continuing from file")
                accumulated_output = file_content
                if self.supports_prompt_caching:
                    messages.append({"role": "assistant", "content": [{"type": "text", "text": file_content, "cache_control": {"type": "ephemeral"}}]})
                else:
                    messages.append({"role": "assistant", "content": file_content})
                logger.debug(f"Using existing content as prefill: {output_file}")
        else:
            if agent_config.use_prefill_from_input and agent_settings.output_ext == "tex" and first_k_tex_document:
                prefill += first_k_tex_document
                accumulated_output = first_k_tex_document

            messages.append({"role": "assistant", "content": prefill})
            logger.debug(f"Anthropic prefill: {prefill}")

            if accumulated_output == "<scratchpad>" and prefill == "<scratchpad>":
                write_file(output_file, prefill)
            elif agent_settings.output_ext == "xml":
                write_file(output_file, prefill + "\n")

        return accumulated_output, False, messages

    def compute_price(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cache_creation_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
    ) -> float:
        """Compute the price for token usage for anthropic models with prompt caching support."""
        base_price = super().compute_price(input_tokens, output_tokens)

        if not self.supports_prompt_caching:
            return base_price

        if cache_creation_tokens:
            base_price += (cache_creation_tokens * self.input_price * 1.25) / 1e6
        if cache_read_tokens:
            base_price += (cache_read_tokens * self.input_price * 0.1) / 1e6

        return base_price


@dataclass
class OpenAICompatibleModelConfig(ModelConfig):
    def get_client(self):
        from openai import OpenAI

        if self.is_openrouter:
            return OpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url="https://openrouter.ai/api/v1")
        elif self.is_openai:
            return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        elif self.is_google:
            return OpenAI(api_key=os.getenv("GOOGLE_API_KEY"), base_url="https://generativelanguage.googleapis.com/v1beta")

    def create_response(
        self,
        client: Any,
        messages: List[Dict],
        temperature: float,
        system_prompt: Optional[str] = None,
        end_tag: Optional[str] = None,
    ) -> Any:
        kwargs = {
            "model": self.full_name,
            "messages": messages,
            "temperature": temperature,
            # For openai model, this value is now in favor of max_tokens, and max_tokens not compatible with o1 series models.
            "max_completion_tokens": self.max_tokens,
        }

        if "o1" in self.name:
            kwargs["temperature"] = 1.0
        else:
            kwargs["stop"] = end_tag

        if self.is_openrouter:
            kwargs["extra_headers"] = {"X-Title": "CoA"}

        return client.chat.completions.create(**kwargs)

    def initialize_messages(self, user_prefix: str, user_request: str, figure_files=None, system_prompt: Optional[str] = None) -> List[Dict]:
        """Initialize messages for the conversation."""
        if "o1" in self.name:
            messages = [{"role": "user", "content": [{"type": "text", "text": system_prompt}, {"type": "text", "text": user_prefix}]}]
        else:
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

        if figure_files:
            image_content = self.create_image_message(figure_files)
            messages[-1]["content"].extend(image_content)

        messages[-1]["content"].append({"type": "text", "text": user_request})

        return messages

    def create_reflection_message(self, messages: List[Dict], user_message: str, figure_files=None) -> List[Dict]:
        """Create a reflection message for OpenAI-compatible models."""
        reflection_message = {"role": "user", "content": []}

        if figure_files:
            image_content = self.create_image_message(figure_files)
            reflection_message["content"].extend(image_content)

        reflection_message["content"].append({"type": "text", "text": user_message})
        messages.append(reflection_message)
        return messages

    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for OpenAI-compatible models."""
        content = []
        for image in image_contents:
            content.extend(
                [
                    {"type": "text", "text": f"Image: {image['file_name']}"},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image['media_type']};base64,{image['data']}",
                            "media_type": image["media_type"],
                            "data": image["data"],
                        },
                    },
                ]
            )
        return content

    def extract_response_statistics(self, response_object, end_tag: str = None) -> Tuple[str, int, int, str]:
        """
        Extract statistics from OpenAI response object.
        finish_reason: The reason the model stopped generating tokens.
        This will be "stop" if the model hit a natural stop point or a provided stop sequence,
        "length" if the maximum number of tokens specified in the request was reached,
        "content_filter" if content was omitted due to a flag from our content filters,
        "tool_calls" if the model called a tool, or "function_call" (deprecated) if the model called a function.
        """

        # this function needs to be split
        # one part for statistics
        # one part for response extraction

        stop_reason = response_object.choices[0].finish_reason
        new_response = response_object.choices[0].message.content.strip()

        response_usage = response_object.usage

        if response_usage is None:
            logger.error("No usage information in response object")
            input_tokens, output_tokens = 0, 0
        else:
            input_tokens = response_usage.prompt_tokens
            output_tokens = response_usage.completion_tokens

            # for openai models, we can get more detailed usage information
            # cached_tokens = response_usage.prompt_tokens_details.cached_tokens
            # reasoning_tokens = response_usage.completion_tokens_details.reasoning_tokens
            # accepted_prediction_tokens = response_usage.completion_tokens_details.accepted_prediction_tokens
            # rejected_prediction_tokens = response_usage.completion_tokens_details.rejected_prediction_tokens

        # maybe in some cases, we need to use \\end{document} instead of end_tag
        if "stop" in stop_reason and f"{end_tag}" not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, input_tokens, output_tokens, stop_reason

    def process_image(self, figure_file: str, file_extension: str) -> Tuple[str, str]:
        """Process image for OpenAI-compatible models."""
        if file_extension.lower() == ".pdf":
            from .img_utils import process_pdf_input

            img_data = process_pdf_input(figure_file)
            media_type = "image/png"
        else:
            with open(figure_file, "rb") as f:
                img_data = base64.b64encode(f.read()).decode("utf-8")
            media_type = "image/png" if file_extension.lower() in [".png", ".jpg", ".jpeg"] else "application/octet-stream"
        return img_data, media_type

    def handle_continuation(self, messages: List[Dict], state: State, agent_settings: AgentSettings, agent_config: AgentConfig):
        """Handle continuation for OpenAI-compatible models."""
        prefill_tokens = state.last_response[-agent_config.K :]
        user_message_continuation = (
            f"Your response got cut off, because you only have limited response space. "
            f"Continue writing exactly from where you left off until the very end, "
            f"marked by {agent_settings.end_tag}. "
            "Avoid repeat yourself and avoid starting over. "
            f'Start your response at the next token after: "{prefill_tokens}"'
        )
        logger.info("User message: " + user_message_continuation)
        messages.append({"role": "user", "content": user_message_continuation})

    def initialize_output_and_prefill(
        self,
        output_file: str,
        agent_config: AgentConfig,
        agent_settings: AgentSettings,
        messages: List[Dict],
        prefill: str,
        accumulated_output: str,
        first_k_tex_document: Optional[str] = None,
    ) -> Tuple[str, bool, List[Dict]]:
        """Initialize output and handle prefill for OpenAI-compatible models."""
        if os.path.exists(output_file) and os.path.getsize(output_file) > 15:
            # try to get prefill from existing file
            file_content = read_file(output_file)
            if agent_settings.has_end_tag(file_content):
                logger.debug("End tag detected - skipping continuation")
                messages.append({"role": "assistant", "content": file_content})
                return None, True, messages
            else:
                logger.warning("Output file exists but no end tag found - continuing from file")
                accumulated_output = file_content
                messages.append({"role": "assistant", "content": file_content})
                logger.debug(f"Using existing content as prefill: {output_file}")
                state = State.initialize(accumulated_output)
                self.handle_continuation(messages, state, agent_settings, agent_config)
        else:
            if agent_config.use_prefill_from_input:
                prefill += first_k_tex_document
                accumulated_output = ""

                if agent_settings.output_ext == "tex" and first_k_tex_document:
                    prefill = f"<latex_document>{first_k_tex_document}"

            openai_prefill = f"Start your response with\n{prefill}"
            messages[-1]["content"].append({"type": "text", "text": openai_prefill})
            logger.debug(f"OpenAI prefill: {openai_prefill}")

        return accumulated_output, False, messages

    def compute_price(
        self,
        input_tokens: int,
        output_tokens: int,
        # for openai models with prompt caching support
        cache_tokens: Optional[int] = None,
        # for openai models with reasoning tokens support
        reasoning_tokens: Optional[int] = None,
        # for anthropic models with prompt caching support
        cache_creation_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
    ) -> float:
        """
        Compute the price for token usage for OpenAI-compatible models.
        In the future this should just take response_object.usage as input.
        """
        if reasoning_tokens:
            total_output_tokens = output_tokens + reasoning_tokens
        else:
            total_output_tokens = output_tokens

        if cache_tokens:
            total_input_tokens = (input_tokens - cache_tokens) + cache_tokens * 0.5
        else:
            total_input_tokens = input_tokens

        return (total_input_tokens * self.input_price + total_output_tokens * self.output_price) / 1e6


MODEL_CONFIGS: Dict[str, ModelConfig] = {
    # Anthropic Claude models
    "opus": AnthropicModelConfig(
        name="opus",
        full_name="claude-3-opus-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=4096,
        context_window=200000,
        input_price=15.0,
        output_price=75.0,
        supports_prompt_caching=True,
        supports_assistant_prefill=True,
    ),
    "sonnet++": AnthropicModelConfig(
        name="sonnet++",
        full_name="claude-3-5-sonnet-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        context_window=200000,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
        supports_native_pdf=True,
        supports_assistant_prefill=True,
        likes_to_ask_for_confirmation=True,
    ),
    "sonnet+": AnthropicModelConfig(
        name="sonnet+",
        full_name="claude-3-5-sonnet-20240620",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        context_window=200000,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
        supports_assistant_prefill=True,
    ),
    "sonnet": AnthropicModelConfig(
        name="sonnet",
        full_name="claude-3-sonnet-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        context_window=200000,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=False,
        supports_assistant_prefill=True,
    ),
    "haiku+": AnthropicModelConfig(
        name="haiku+",
        full_name="claude-3-5-haiku-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        context_window=200000,
        input_price=1.0,
        output_price=5.0,
        supports_prompt_caching=True,
        supports_vision=False,
        supports_assistant_prefill=True,
        likes_to_ask_for_confirmation=True,
    ),
    "haiku": AnthropicModelConfig(
        name="haiku",
        full_name="claude-3-haiku-20240307",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        context_window=200000,
        input_price=0.25,
        output_price=1.25,
        supports_prompt_caching=True,
        supports_assistant_prefill=True,
    ),
    # OpenAI models
    "gpto1": OpenAICompatibleModelConfig(
        name="gpto1",
        full_name="o1-preview-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=32768,
        context_window=128000,
        input_price=15.0,
        output_price=60.0,
        supports_vision=False,
        supports_reasoning=True,
    ),
    "gpto1-": OpenAICompatibleModelConfig(
        name="gpto1-",
        full_name="o1-mini-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=65536,
        context_window=128000,
        input_price=3.0,
        output_price=12.0,
        supports_vision=False,
        supports_reasoning=True,
    ),
    "gpt4o": OpenAICompatibleModelConfig(
        name="gpt4o",
        # full_name="gpt-4o-2024-08-06",
        # gpt-4o,
        full_name="gpt-4o-2024-11-20",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        context_window=128000,
        input_price=2.5,
        output_price=10.0,
        supports_predictive_output=True,
    ),
    "gpt4t": OpenAICompatibleModelConfig(
        name="gpt4t",
        full_name="gpt-4-turbo-2024-04-09",
        provider=ModelProvider.OPENAI,
        max_tokens=4096,
        context_window=128000,
        input_price=10.0,
        output_price=30.0,
    ),
    "gpt4o-": OpenAICompatibleModelConfig(
        name="gpt4o-",
        full_name="gpt-4o-mini-2024-07-18",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        context_window=128000,
        input_price=0.15,
        output_price=0.6,
        supports_predictive_output=True,
    ),
    "gpt4ol": OpenAICompatibleModelConfig(
        name="gpt4ol",
        full_name="chatgpt-4o-latest",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        context_window=128000,
        input_price=5.0,
        output_price=15.0,
    ),
    # Google Gemini models
    "gemini1p+": OpenAICompatibleModelConfig(
        name="gemini1p+",
        full_name="gemini-1.5-pro-latest",
        provider=ModelProvider.GOOGLE,
        max_tokens=8192,
        input_price=1.25,
        output_price=5.0,
    ),
    "gemini1f+": OpenAICompatibleModelConfig(
        name="gemini1f+",
        full_name="gemini-1.5-fresh-latest",
        provider=ModelProvider.GOOGLE,
        max_tokens=8192,
        context_window=1048576,
        input_price=0.075,
        output_price=0.3,
    ),
    "geminiexp": OpenAICompatibleModelConfig(
        name="geminiexp",
        full_name="gemini-exp-1206",
        provider=ModelProvider.GOOGLE,
        max_tokens=4096,
        context_window=2097152,
        input_price=1.25,
        output_price=5.0,
    ),
    # OpenRouter models
    "gpt4oOR": OpenAICompatibleModelConfig(
        name="gpt4oOR",
        full_name="openai/gpt-4o:extended",
        provider=ModelProvider.OPENROUTER,
        max_tokens=64000,
        context_window=128000,
        input_price=6.0,
        output_price=18.0,
    ),
    "gemini1p+OR": OpenAICompatibleModelConfig(
        name="gemini1p+OR",
        full_name="google/gemini-pro-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        context_window=2097152,
        input_price=2.5,
        output_price=7.5,
    ),
    "gemini1f+OR": OpenAICompatibleModelConfig(
        name="gemini1f+OR",
        full_name="google/gemini-flash-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        context_window=1048576,
        input_price=0.075,
        output_price=0.3,
    ),
    "llama3+OR": OpenAICompatibleModelConfig(
        name="llama3+OR",
        full_name="meta-llama/llama-3.1-405b-instruct",
        provider=ModelProvider.OPENROUTER,
        max_tokens=131072,
        context_window=131072,
        input_price=3.0,
        output_price=3.0,
    ),
    "qwq-32b": OpenAICompatibleModelConfig(
        name="qwq-32b",
        full_name="qwen/qwq-32b-preview",
        provider=ModelProvider.OPENROUTER,
        max_tokens=32768,
        context_window=32768,
        input_price=0.15,
        output_price=0.6,
    ),
}
