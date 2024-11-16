from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional, Any
import os
from dotenv import load_dotenv

load_dotenv()


class ModelProvider(Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    GOOGLE = "google"
    OPENROUTER = "openrouter"


@dataclass
class ModelConfig:
    name: str  # Short name (e.g., "sonnet++")
    full_name: str  # Full model name (e.g., "claude-3-5-sonnet-20241022")
    provider: ModelProvider
    max_tokens: int
    input_price: float
    output_price: float
    supports_prompt_caching: bool = False
    supports_vision: bool = True
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

    def get_client(self):
        """Get the appropriate client for this model."""
        if self.is_anthropic:
            from anthropic import Anthropic

            return Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

        from openai import OpenAI

        if self.is_openrouter:
            return OpenAI(api_key=os.getenv("OPENROUTER_API_KEY"), base_url="https://openrouter.ai/api/v1")
        elif self.is_openai:
            return OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        else:
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
        """Create a response using the appropriate API call for this model."""
        if self.is_anthropic:
            return self._create_anthropic_response(client, messages, temperature, system_prompt, end_tag)
        else:
            return self._create_openai_response(client, messages, temperature, end_tag, extra_kwargs)

    def _create_anthropic_response(self, client, messages, temperature, system_prompt, end_tag):
        """Create a response using Anthropic's API."""
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

    def _create_openai_response(self, client, messages, temperature, end_tag, extra_kwargs):
        """Create a response using OpenAI-compatible API."""
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

    def compute_price(
        self, input_tokens: int, output_tokens: int, cache_creation_tokens: Optional[int] = None, cache_read_tokens: Optional[int] = None
    ) -> float:
        """Compute the price for token usage."""
        base_price = (input_tokens * self.input_price + output_tokens * self.output_price) / 1e6

        if not self.supports_prompt_caching:
            return base_price

        if cache_creation_tokens:
            base_price += (cache_creation_tokens * self.input_price * 1.25) / 1e6
        if cache_read_tokens:
            base_price += (cache_read_tokens * self.input_price * 0.1) / 1e6

        return base_price


MODEL_CONFIGS: Dict[str, ModelConfig] = {
    # Anthropic Claude models
    "sonnet++": ModelConfig(
        name="sonnet++",
        full_name="claude-3-5-sonnet-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
    ),
    "sonnet+": ModelConfig(
        name="sonnet+",
        full_name="claude-3-5-sonnet-20240620",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
    ),
    "opus": ModelConfig(
        name="opus",
        full_name="claude-3-opus-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=4096,
        input_price=15.0,
        output_price=75.0,
        supports_prompt_caching=True,
    ),
    "sonnet": ModelConfig(
        name="sonnet",
        full_name="claude-3-sonnet-20240229",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=3.0,
        output_price=15.0,
        supports_prompt_caching=True,
    ),
    "haiku+": ModelConfig(
        name="haiku+",
        full_name="claude-3-5-haiku-20241022",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=1.0,
        output_price=5.0,
        supports_prompt_caching=True,
        supports_vision=False,
    ),
    "haiku": ModelConfig(
        name="haiku",
        full_name="claude-3-haiku-20240307",
        provider=ModelProvider.ANTHROPIC,
        max_tokens=8192,
        input_price=0.25,
        output_price=1.25,
        supports_prompt_caching=True,
    ),
    # OpenAI models
    "gpto1": ModelConfig(
        name="gpto1",
        full_name="o1-preview-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=32768,
        input_price=15.0,
        output_price=60.0,
        supports_vision=False,
    ),
    "gpto1-": ModelConfig(
        name="gpto1-",
        full_name="o1-mini-2024-09-12",
        provider=ModelProvider.OPENAI,
        max_tokens=65536,
        input_price=3.0,
        output_price=12.0,
        supports_vision=False,
    ),
    "gpt4o": ModelConfig(
        name="gpt4o",
        full_name="gpt-4o-2024-08-06",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=2.5,
        output_price=10.0,
    ),
    "gpt4t": ModelConfig(
        name="gpt4t",
        full_name="gpt-4-turbo-2024-04-09",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=10.0,
        output_price=30.0,
    ),
    "gpt4o-": ModelConfig(
        name="gpt4o-",
        full_name="gpt-4o-mini-2024-07-18",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=0.15,
        output_price=0.6,
    ),
    "gpt4ol": ModelConfig(
        name="gpt4ol",
        full_name="chatgpt-4o-latest",
        provider=ModelProvider.OPENAI,
        max_tokens=16384,
        input_price=5.0,
        output_price=15.0,
    ),
    # Google Gemini models
    "gemini1p+": ModelConfig(
        name="gemini1p+",
        full_name="gemini-1.5-pro-latest",
        provider=ModelProvider.GOOGLE,
        max_tokens=8192,
        input_price=1.25,
        output_price=5.0,
    ),
    "gemini1f+": ModelConfig(
        name="gemini1f+",
        full_name="gemini-1.5-fresh-latest",
        provider=ModelProvider.GOOGLE,
        max_tokens=8192,
        input_price=0.075,
        output_price=0.3,
    ),
    # OpenRouter models
    "gpt4oOR": ModelConfig(
        name="gpt4oOR",
        full_name="openai/gpt-4o:extended",
        provider=ModelProvider.OPENROUTER,
        max_tokens=64000,
        input_price=6.0,
        output_price=18.0,
    ),
    "gemini1p+OR": ModelConfig(
        name="gemini1p+OR",
        full_name="google/gemini-pro-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        input_price=2.5,
        output_price=7.5,
    ),
    "gemini1f+OR": ModelConfig(
        name="gemini1f+OR",
        full_name="google/gemini-flash-1.5",
        provider=ModelProvider.OPENROUTER,
        max_tokens=8192,
        input_price=0.075,
        output_price=0.3,
    ),
    "llama3+OR": ModelConfig(
        name="llama3+OR",
        full_name="meta-llama/llama-3.1-405b-instruct",
        provider=ModelProvider.OPENROUTER,
        max_tokens=131072,
        input_price=3.0,
        output_price=3.0,
    ),
}
