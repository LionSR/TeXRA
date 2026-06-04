const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * 1024;

/**
 * Deliberately loose cap: blocks runaway free-tier contexts without policing
 * normal research requests.
 */
export const FREE_TIER_REQUEST_BODY_LIMIT_BYTES = 2 * BYTES_PER_MIB;

const textEncoder = new TextEncoder();

export interface RequestBodySizeCheck {
  allowed: boolean;
  limitBytes: number;
  requestBytes: number;
}

export type RequestBodyReadResult =
  | (RequestBodySizeCheck & { allowed: true; body: Uint8Array })
  | (RequestBodySizeCheck & { allowed: false; body: null });

export type RequestBodyForSizeCheck =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | null;

function requestBodyByteLength(body: RequestBodyForSizeCheck): number {
  if (body == null) return 0;
  if (typeof body === 'string') return textEncoder.encode(body).byteLength;
  return body.byteLength;
}

export function checkRequestBodySizeLimit(
  body: RequestBodyForSizeCheck,
  limitBytes: number = FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
): RequestBodySizeCheck {
  const requestBytes = requestBodyByteLength(body);

  return {
    allowed: requestBytes <= limitBytes,
    limitBytes,
    requestBytes,
  };
}

function concatChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readRequestBodyWithinSizeLimit(
  body: ReadableStream<Uint8Array> | null,
  limitBytes: number = FREE_TIER_REQUEST_BODY_LIMIT_BYTES,
): Promise<RequestBodyReadResult> {
  if (body === null) {
    return {
      allowed: true,
      body: new Uint8Array(),
      limitBytes,
      requestBytes: 0,
    };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let requestBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      requestBytes += value.byteLength;
      if (requestBytes > limitBytes) {
        await reader.cancel();
        return { allowed: false, body: null, limitBytes, requestBytes };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    allowed: true,
    body: concatChunks(chunks, requestBytes),
    limitBytes,
    requestBytes,
  };
}

export function formatRequestBytes(bytes: number): string {
  if (bytes >= BYTES_PER_MIB && bytes % BYTES_PER_MIB === 0) {
    return `${bytes / BYTES_PER_MIB} MiB`;
  }
  if (bytes >= BYTES_PER_KIB && bytes % BYTES_PER_KIB === 0) {
    return `${bytes / BYTES_PER_KIB} KiB`;
  }
  return `${bytes} bytes`;
}
