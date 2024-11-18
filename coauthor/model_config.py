from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Any, Tuple
import os
from dotenv import load_dotenv
from .logging_utils import logger

load_dotenv()

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
    supports_prompt_caching: bool = False
    supports_vision: bool = True
    supports_native_pdf: bool = False
    base_url: Optional[str] = None

    @property
    def is_anthropic(self) -> bool:
        return self.provider == ModelProvider.ANTHROPIC

    @property
    def is_openai(self) -> bool:
        return self.provider == ModelProvider.OPENAI

    @property
    def is_openrouter(self) -> bool:
        return self.provider == ModelProvider.OPENROUTER

    @property
    def is_google(self) -> bool:
        return self.provider == ModelProvider.GOOGLE

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
        system_prompt: str,
        end_tag: Optional[str] = None,
        extra_kwargs: Optional[Dict] = None,
    ) -> Any:
        """Create a response using the appropriate API call for this model."""
        pass

    @abstractmethod
    def initialize_messages(self, system_prompt: str, user_prefix: str, user_request: str, figure_inputs=None) -> List[Dict]:
        """Initialize messages for the conversation."""
        pass

    @abstractmethod
    def create_reflection_message(self, user_message: str, figure_inputs=None) -> Dict:
        """Create a reflection message for the model."""
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

    def compute_price(
        self, input_tokens: int, output_tokens: int, cache_creation_tokens: Optional[int] = None, cache_read_tokens: Optional[int] = None
    ) -> float:
        """Compute the price for token usage."""
        return (input_tokens * self.input_price + output_tokens * self.output_price) / 1e6


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
        system_prompt: str,
        end_tag: Optional[str] = None,
        extra_kwargs: Optional[Dict] = None,
    ) -> Any:
        extra_headers = []
        if self.supports_prompt_caching:
            extra_headers.append("prompt-caching-2024-07-31")
            if self.name == "sonnet++":
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

    def compute_price(
        self, input_tokens: int, output_tokens: int, cache_creation_tokens: Optional[int] = None, cache_read_tokens: Optional[int] = None
    ) -> float:
        """Compute the price for token usage with prompt caching support."""
        base_price = super().compute_price(input_tokens, output_tokens)

        if not self.supports_prompt_caching:
            return base_price

        if cache_creation_tokens:
            base_price += (cache_creation_tokens * self.input_price * 1.25) / 1e6
        if cache_read_tokens:
            base_price += (cache_read_tokens * self.input_price * 0.1) / 1e6

        return base_price

    def initialize_messages(self, system_prompt: str, user_prefix: str, user_request: str, figure_inputs=None) -> List[Dict]:
        """Initialize messages for the conversation."""
        messages = [{"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

        if figure_inputs:
            from .message_utils import create_image_message
            image_content = create_image_message(self, figure_inputs)
            messages[-1]["content"].extend(image_content)

        if self.supports_prompt_caching:
            messages[-1]["content"].append({"type": "text", "text": user_request, "cache_control": {"type": "ephemeral"}})
        else:
            messages[-1]["content"].append({"type": "text", "text": user_request})

        return messages

    def create_reflection_message(self, user_message: str, figure_inputs=None) -> Dict:
        """Create a reflection message for Anthropic models."""
        reflection_message = {"role": "user", "content": []}

        if figure_inputs:
            from .message_utils import create_image_message
            image_content = create_image_message(self, figure_inputs)
            reflection_message["content"].extend(image_content)

        if self.supports_prompt_caching:
            reflection_message["content"].append({"type": "text", "text": user_message, "cache_control": {"type": "ephemeral"}})
        else:
            reflection_message["content"].append({"type": "text", "text": user_message})

        return reflection_message

    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for Anthropic models."""
        content = []
        for image in image_contents:
            if self.supports_native_pdf and image["media_type"] == "application/pdf":
                content.extend([
                    {"type": "text", "text": f"Document: {image['file_name']}"},
                    {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": image["data"]}},
                ])
            else:
                content.extend([
                    {"type": "text", "text": f"Image: {image['file_name']}"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image["media_type"],
                            "data": image["data"],
                        },
                    },
                ])
        return content

    def extract_response_statistics(self, response_object, end_tag: str = None) -> Tuple[str, int, int, str]:
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

        if stop_reason == "stop_sequence" and "\\end{document}" not in new_response:
            new_response += f"\n{end_tag}"

        return new_response, input_tokens, output_tokens, stop_reason


@dataclass
class OpenAICompatibleModelConfig(ModelConfig):
    def get_client(self):
        from openai import OpenAI
        if self.is_openrouter:
            return OpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url="https://openrouter.ai/api/v1")
        elif self.is_openai:
            return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        else:  # Google
            return OpenAI(api_key=os.getenv("GOOGLE_API_KEY"), base_url="https://generativelanguage.googleapis.com/v1beta")

    def create_response(
        self,
        client: Any,
        messages: List[Dict],
        temperature: float,
        system_prompt: str,
        end_tag: Optional[str] = None,
        extra_kwargs: Optional[Dict] = None,
    ) -> Any:
        kwargs = {
            "model": self.full_name,
            "messages": messages,
            "temperature": temperature,
            "max_completion_tokens": self.max_tokens,
        }

        if "o1" in self.name:
            kwargs["temperature"] = 1.0
        else:
            kwargs["stop"] = end_tag

        if self.is_openrouter:
            kwargs["extra_headers"] = {"X-Title": "CoA"}

        if extra_kwargs:
            kwargs.update(extra_kwargs)

        return client.chat.completions.create(**kwargs)

    def initialize_messages(self, system_prompt: str, user_prefix: str, user_request: str, figure_inputs=None) -> List[Dict]:
        """Initialize messages for the conversation."""
        if "o1" in self.name:
            messages = [{"role": "user", "content": [{"type": "text", "text": system_prompt}, {"type": "text", "text": user_prefix}]}]
        else:
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": [{"type": "text", "text": user_prefix}]}]

        if figure_inputs:
            from .message_utils import create_image_message
            image_content = create_image_message(self, figure_inputs)
            messages[-1]["content"].extend(image_content)

        messages[-1]["content"].append({"type": "text", "text": user_request})

        return messages

    def create_reflection_message(self, user_message: str, figure_inputs=None) -> Dict:
        """Create a reflection message for OpenAI-compatible models."""
        reflection_message = {"role": "user", "content": []}

        if figure_inputs:
            from .message_utils import create_image_message
            image_content = create_image_message(self, figure_inputs)
            reflection_message["content"].extend(image_content)

        reflection_message["content"].append({"type": "text", "text": user_message})

        return reflection_message

    def create_image_content(self, image_contents: list) -> List[Dict]:
        """Create image content for OpenAI-compatible models."""
        content = []
        for image in image_contents:
            content.extend([
                {"type": "text", "text": f"Image: {image['file_name']}"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image['media_type']};base64,{image['data']}",
                        "media_type": image["media_type"],
                        "data": image["data"],
                    },
                },
            ])
        return content

    def extract_response_statistics(self, response_object, end_tag: str = None) -> Tuple[str, int, int, str]:
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


MODEL_CONFIGS: Dict[str, ModelConfig] = {
    # Anthropic Claude models
    "sonnet++": AnthropicModelConfig(
        name="sonnet++",
        full_name="claude-3-5-sonnet-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
        supports_native_pdf=True,
    ),
    "sonnet+": AnthropicModelConfig(
        name="sonnet+",
        full_name="claude-3-5-sonnet-20240620",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
    ),
    "opus": AnthropicModelConfig(
        name="opus",
        full_name="claude-3-opus-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=4096,
        input_price=15.0,
        output_price=75.0,
        supports_prompt_caching=True,
    ),
    "sonnet": AnthropicModelConfig(
        name="sonnet",
        full_name="claude-3-sonnet-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=False,
    ),
    "haiku+": AnthropicModelConfig(
        name="haiku+",
        full_name="claude-3-5-haiku-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=1.0,
        output_price=5.0,
        supports_prompt_caching=True,
        supports_vision=False,
    ),
    "haiku": AnthropicModelConfig(
        name="haiku",
        full_name="claude-3-haiku-20240307",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=0.25,
        output_price=1.25,
        supports_prompt_caching=True,
    ),
    # OpenAI models
    "gpto1": OpenAICompatibleModelConfig(
        name="gpto1",
        full_name="o1-preview-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=32768,
        input_price=15.0,
        output_price=60.0,
        supports_vision=False,
    ),
    "gpto1-": OpenAICompatibleModelConfig(
        name="gpto1-",
        full_name="o1-mini-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=65536,
        input_price=3.0,
        output_price=12.0,
        supports_vision=False,
    ),
    "gpt4o": OpenAICompatibleModelConfig(
        name="gpt4o",
        full_name="gpt-4o-2024-08-06",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=2.5,
        output_price=10.0,
    ),
    "gpt4t": OpenAICompatibleModelConfig(
        name="gpt4t",
        full_name="gpt-4-turbo-2024-04-09",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=10.0,
        output_price=30.0,
    ),
    "gpt4o-": OpenAICompatibleModelConfig(
        name="gpt4o-",
        full_name="gpt-4o-mini-2024-07-18",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=0.15,
        output_price=0.6,
    ),
    "gpt4ol": OpenAICompatibleModelConfig(
        name="gpt4ol",
        full_name="chatgpt-4o-latest",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
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
        input_price=0.075,
        output_price=0.3,
    ),
    # OpenRouter models
    "gpt4oOR": OpenAICompatibleModelConfig(
        name="gpt4oOR",
        full_name="openai/gpt-4o:extended",
        provider=ModelProvider.OPENROUTER,
        max_tokens=64000,
        input_price=6.0,
        output_price=18.0,
    ),
    "gemini1p+OR": OpenAICompatibleModelConfig(
        name="gemini1p+OR",
        full_name="google/gemini-pro-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        input_price=2.5,
        output_price=7.5,
    ),
    "gemini1f+OR": OpenAICompatibleModelConfig(
        name="gemini1f+OR",
        full_name="google/gemini-flash-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        input_price=0.075,
        output_price=0.3,
    ),
    "llama3+OR": OpenAICompatibleModelConfig(
        name="llama3+OR",
        full_name="meta-llama/llama-3.1-405b-instruct",
        provider=ModelProvider.OPENROUTER,
        max_tokens=131072,
        input_price=3.0,
        output_price=3.0,
    ),
}
