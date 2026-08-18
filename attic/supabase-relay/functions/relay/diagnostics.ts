import { getCanonicalRelayModelName } from './models.ts';

export type RelayFailurePhase =
  'pre_headers_timeout' | 'pre_headers_failure' | 'response_body_failure';

export const RELAY_REQUEST_ID_HEADER = 'x-relay-request-id';

const UPSTREAM_REQUEST_ID_HEADERS = [
  'request-id',
  'x-request-id',
  'x-goog-request-id',
] as const;
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

type RelayRequestBody =
  string | Uint8Array | ReadableStream<Uint8Array> | null | undefined;

interface RelayFailureDiagnostic {
  relayRequestId: string;
  provider: string;
  model: string | null;
  requestBytes: number | null;
  elapsedMs: number;
  failurePhase: RelayFailurePhase;
  upstreamRequestId: string | null;
}

/** Attach the relay id to a relay-generated error using both its specific
 * header and the standard request-id header understood by SDK clients. */
export function withRelayErrorRequestId(
  response: Response,
  relayRequestId: string,
): Response {
  response.headers.set(RELAY_REQUEST_ID_HEADER, relayRequestId);
  response.headers.set('x-request-id', relayRequestId);
  return response;
}

export function classifyPreHeaderFailure(error: unknown): RelayFailurePhase {
  return error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? 'pre_headers_timeout'
    : 'pre_headers_failure';
}

function sanitizeRequestId(requestId: string | null): string | null {
  const trimmed = requestId?.trim();
  return trimmed && SAFE_REQUEST_ID_RE.test(trimmed) ? trimmed : null;
}

export function logRelayFailure(diagnostic: RelayFailureDiagnostic): void {
  console.error(
    `[RELAY] ${JSON.stringify({
      event: 'upstream_failure',
      ...diagnostic,
      model: getCanonicalRelayModelName(diagnostic.model),
      upstreamRequestId: sanitizeRequestId(diagnostic.upstreamRequestId),
    })}`,
  );
}

export function getUpstreamRequestId(headers: Headers): string | null {
  for (const header of UPSTREAM_REQUEST_ID_HEADERS) {
    const requestId = sanitizeRequestId(headers.get(header));
    if (requestId) return requestId;
  }
  return null;
}

export function getRelayRequestBytes(
  body: RelayRequestBody,
  contentLength: string | null,
): number | null {
  if (body == null) return 0;
  if (typeof body === 'string')
    return new TextEncoder().encode(body).byteLength;
  if (body instanceof Uint8Array) return body.byteLength;

  if (contentLength == null || contentLength.trim() === '') return null;
  const parsedLength = Number(contentLength);
  return Number.isSafeInteger(parsedLength) && parsedLength >= 0
    ? parsedLength
    : null;
}
