// Third-party imports
import { ApiError as GoogleApiError } from '@google/genai';

// Local imports - common errors
import { sdkErrorKindFromStatusCode } from '@common/errors/sdkErrorUtils';

// Local imports - support
import { tagSdkError } from '../support/sdkErrorMetadata';

export function tagGoogleSdkError(err: unknown, provider = 'google'): void {
  if (err instanceof GoogleApiError) {
    tagSdkError(
      err,
      provider,
      sdkErrorKindFromStatusCode(err.status),
      err.status,
    );
  }
}
