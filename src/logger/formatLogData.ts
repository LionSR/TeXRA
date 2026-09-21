/**
 * Render a debug payload for display. Lives apart from both writers so an
 * entry carries its `data` payload raw all the way to the host: the sinks
 * that render annotations apply this at display time, and `createLog`'s own
 * writer applies it to the payload it writes.
 */
// Third-party imports
import safeStringify from 'safe-stable-stringify';

/**
 * Flatten an `Error` into the plain object `JSON.stringify` would otherwise
 * render as `{}`: its three non-enumerable display fields, its `cause` (also
 * non-enumerable when set through the constructor option), and its own
 * enumerable properties (e.g. `statusCode`, `requestId`). `AggregateError`'s
 * `errors` and a system error's `code` are own but non-enumerable, so they are
 * copied by name too: without them an aggregated failure would render as the
 * wrapper's message alone, with every underlying failure dropped. A nested
 * `cause` that is itself an `Error` reaches this function again through the
 * replacer below, so a cause chain flattens whole. The spread comes first so
 * the named fields are not reported as overwritten; the values are identical
 * either way, since reading `error.name` returns an own enumerable `name` when
 * one exists.
 *
 * `flattened` is what keeps a cycle finite. `safe-stable-stringify` detects a
 * cycle by looking for the *post-replacer* value on its own stack, so handing
 * it a fresh object for each visit of the same `Error` would defeat that check
 * and recurse until the stack overflows. One object per `Error` per render
 * makes the identity it tests stable, and a self-referential property or a
 * `cause` cycle renders `"[Circular]"`.
 */
function serializeError(
  error: Error,
  flattened: WeakMap<Error, Record<string, unknown>>,
): Record<string, unknown> {
  const existing = flattened.get(error);
  if (existing !== undefined) return existing;
  const flat: Record<string, unknown> = {};
  flattened.set(error, flat);
  Object.assign(flat, error, {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  if (error.cause !== undefined) flat['cause'] = error.cause;
  if (error instanceof AggregateError) flat['errors'] = error.errors;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) flat['code'] = code;
  return flat;
}

/**
 * Render one debug payload. Errors don't survive `JSON.stringify`, so they're
 * flattened here, each `Error` to one object for the whole render so
 * `safe-stable-stringify` still renders a cycle as `"[Circular]"`.
 */
export function formatLogData(data: unknown): string {
  if (typeof data !== 'object' || data === null) return String(data);
  const flattened = new WeakMap<Error, Record<string, unknown>>();
  return (
    safeStringify(
      data,
      (_key, value) =>
        value instanceof Error ? serializeError(value, flattened) : value,
      2,
    ) ?? String(data)
  );
}
