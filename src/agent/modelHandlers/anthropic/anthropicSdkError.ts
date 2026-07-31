// Third-party imports
import {
  APIConnectionError as AnthropicAPIConnectionError,
  APIConnectionTimeoutError as AnthropicAPIConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAPIUserAbortError,
} from '@anthropic-ai/sdk';

// Local imports - support
import {
  matchMappedSdkError,
  type SdkErrorClassMapping,
} from '../support/sdkErrorMetadata';

const ANTHROPIC_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: AnthropicAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: AnthropicAPIConnectionError, kind: 'connection' },
  { ctor: AnthropicAPIUserAbortError, kind: 'user_abort' },
];

export function tagAnthropicSdkError(err: unknown, provider: string): void {
  matchMappedSdkError(
    err,
    provider,
    ANTHROPIC_SDK_ERROR_MAPPINGS,
    AnthropicAPIError,
  );
}
