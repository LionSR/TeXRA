// Third-party imports
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';

// Local imports - common
import {
  attachStreamDiagnostics,
  isUserAbort,
} from '@common/errors/sdkErrorUtils';

// Local imports - shared
import type { StreamDiagnostics } from '@shared/schemas';

// Local file imports
import { tagAnthropicSdkError } from './anthropicSdkError';

type ErrorWithRequestId = Error & { request_id?: string };

interface AnthropicStreamErrorContext {
  readonly diagnostics: StreamDiagnostics;
  readonly requestId?: string;
  readonly provider: string;
  readonly model: string;
  readonly isUsingRelay: boolean;
  readonly baseUrl: string;
  readonly logger: AgentTrace;
}

/** Enriches an Anthropic stream failure without hiding SDK or abort identity. */
export function decorateAnthropicStreamError(
  error: unknown,
  partialText: string,
  context: AnthropicStreamErrorContext,
): unknown {
  tagAnthropicSdkError(error, context.provider);

  const isAbort = isUserAbort(error);
  const enrichedError =
    !context.diagnostics.messageStartReceived &&
    error instanceof Error &&
    !(error instanceof AnthropicAPIError) &&
    !isAbort
      ? new Error(
          `Stream closed before message_start after ${context.diagnostics.elapsedSecs}s ` +
            `(${context.diagnostics.eventsProcessed} events). ` +
            'Likely connection dropped before the API responded.',
          { cause: error },
        )
      : error;

  // detectRequestId() reads request_id from the thrown object.
  if (context.requestId && enrichedError instanceof Error) {
    (enrichedError as ErrorWithRequestId).request_id = context.requestId;
  }

  // The retry node owns user-facing failure reporting. Diagnostics stay on the
  // debug channel so the same failure does not produce a second visible row.
  context.logger.debug(`Stream ${isAbort ? 'aborted' : 'failed'}`, {
    data: {
      isUsingRelay: context.isUsingRelay,
      baseUrl: context.baseUrl,
      model: context.model,
      streamDiagnostics: context.diagnostics,
      partialTextLength: partialText.length,
      error: enrichedError,
    },
  });

  attachStreamDiagnostics(enrichedError, context.diagnostics);
  return enrichedError;
}
