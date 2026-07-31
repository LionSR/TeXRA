// Third-party imports
import {
  APIConnectionError as OpenAIAPIConnectionError,
  APIConnectionTimeoutError as OpenAIAPIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
} from 'openai';

// Local imports - support
import {
  matchMappedSdkError,
  type SdkErrorClassMapping,
} from '../support/sdkErrorMetadata';

const OPENAI_SDK_ERROR_MAPPINGS: readonly SdkErrorClassMapping[] = [
  { ctor: OpenAIAPIConnectionTimeoutError, kind: 'connection_timeout' },
  { ctor: OpenAIAPIConnectionError, kind: 'connection' },
  { ctor: OpenAIAPIUserAbortError, kind: 'user_abort' },
];

export function tagOpenAISdkError(err: unknown, provider: string): void {
  matchMappedSdkError(err, provider, OPENAI_SDK_ERROR_MAPPINGS, OpenAIAPIError);
}
