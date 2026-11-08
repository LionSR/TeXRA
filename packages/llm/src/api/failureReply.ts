/**
 * Reading a failed request's reply: the SDK's body, the adapter's HTTP
 * status or a streamed error's type, and the message that is safe to show.
 * The verdict (`verdict.ts`) is decided over this reading.
 */
// Third-party imports
import { Predicate } from 'effect';

// Local imports
import type { ModelError } from '../errors.js';

/** A loosely typed object off an SDK error or a reply body. */
export type Fields = Record<string, unknown>;

/** What one failure's reply says, read once. */
export interface Reply {
  /** The SDK error, or the failure itself when the adapter kept none. */
  readonly source: unknown;
  readonly body: unknown;
  readonly status: number | undefined;
  /**
   * The text to show: the SDK's message, unless it is only the serialized
   * body (which may hold the request); empty when nothing else explains it.
   */
  readonly message: string;
}

/** Whether `value` is an object whose fields can be read. */
export const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null;

/** A non-blank string field. */
export const stringField = (value: Fields, key: string): string | undefined => {
  const field = value[key];
  return typeof field === 'string' && field.trim() !== '' ? field : undefined;
};

/** A finite number field. */
export const numberField = (value: Fields, key: string): number | undefined => {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
};

/** The body and its `{ error }` envelope, as objects: SDKs keep one or the other. */
export const envelopes = (body: unknown): Fields[] =>
  isFields(body) ? [body, body.error].filter(isFields) : [];

/** The first non-blank string `key` across the body and its envelope. */
export const firstString = (body: unknown, key: string): string | undefined =>
  envelopes(body)
    .map((candidate) => stringField(candidate, key))
    .find(Predicate.isNotUndefined);

/** The first finite number `key` across the body and its envelope. */
export const firstNumber = (body: unknown, key: string): number | undefined =>
  envelopes(body)
    .map((candidate) => numberField(candidate, key))
    .find(Predicate.isNotUndefined);

/** JSON text, or `undefined` when it is not JSON. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The status a provider's error type or code stands for, when the reply lost its status. */
const STATUS_BY_ERROR_TYPE: ReadonlyMap<string, number> = new Map([
  ['invalid_request_error', 400],
  ['authentication_error', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['request_too_large', 413],
  ['rate_limit_error', 429],
  ['service_unavailable_error', 503],
  ['server_is_overloaded', 503],
  ['api_error', 500],
  ['server_error', 500],
  ['timeout_error', 408],
  ['overloaded_error', 529],
]);

/** Anthropic's envelope types itself `error`, so the nested type is read first. */
const statusFromBody = (body: unknown): number | undefined =>
  envelopes(body)
    .reverse()
    .flatMap((candidate) => [candidate.type, candidate.code])
    .filter(Predicate.isString)
    .map((value) => STATUS_BY_ERROR_TYPE.get(value))
    .find(Predicate.isNotUndefined);

/** Sorted-key JSON, so a body re-serialized in another key order still matches. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isFields(value)) return JSON.stringify(value) ?? 'null';
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${entries.join(',')}}`;
}

/** Whether `text` is the body serialized, whole or as its embedded JSON. */
function serializes(text: string, body: unknown): boolean {
  if (typeof body === 'string')
    return text === body || text.includes(JSON.stringify(body));
  if (!isFields(body)) return false;
  try {
    const serialized = JSON.stringify(body);
    if (serialized.length > 2 && text.includes(serialized)) return true;
    const [open, close] = Array.isArray(body) ? ['[', ']'] : ['{', '}'];
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    return (
      start >= 0 &&
      end > start &&
      canonical(parsedJson(text.slice(start, end + 1))) === canonical(body)
    );
  } catch {
    // A cyclic body is not one an SDK serialized into its message.
    return false;
  }
}

/** One failure's reply, read once. */
export function readReply(error: ModelError): Reply {
  const source = error.cause instanceof Error ? error.cause : error;
  // The SDKs expose decoded bodies as `error`; Google also keeps a raw
  // `body` when it could not decode one. Terminal events are plain objects.
  const body =
    (isFields(source) ? (source.error ?? source.body) : undefined) ??
    (isFields(error.cause) ? error.cause : undefined);
  // The adapter owns HTTP status. SSE errors may carry only a body type;
  // that type also outranks a non-error HTTP status such as the stream's 200.
  const status =
    error.status !== undefined && error.status >= 400
      ? error.status
      : (statusFromBody(body) ?? error.status);
  const own =
    source instanceof Error && source.message.trim() !== ''
      ? source.message.trim()
      : undefined;
  // Empty when the only text there is would show the serialized body.
  const message =
    (own !== undefined && serializes(own, body) ? undefined : own) ??
    firstString(body, 'message') ??
    (own === undefined ? error.message : '');
  return { source, body, status, message };
}
