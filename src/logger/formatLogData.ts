/**
 * Render a debug payload for display. The write path in `@logger/logSink`
 * applies this once to each entry's raw `data` annotation, before redaction,
 * so every host surface shows the same bounded rendering and no producer
 * decides how much detail a surface shows. The redaction pass shares the
 * `Error` flattener for the raw values its other callers hand it.
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
export function flattenError(
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
    stack: capStack(error.stack),
  });
  if (error.cause !== undefined) flat['cause'] = error.cause;
  if (error instanceof AggregateError) flat['errors'] = error.errors;
  const code = (error as { code?: unknown }).code;
  if (code !== undefined) flat['code'] = code;
  return flat;
}

/** Stack frames kept per `Error`: enough to locate the throw site, few enough
 * that one deep stack cannot fill a bounded rendering on its own. */
const MAX_STACK_FRAMES = 8;

/** Keep a stack's header and its first `MAX_STACK_FRAMES` frames, and say how
 * many were dropped so the cut is visible rather than silent. */
function capStack(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  const lines = stack.split('\n');
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  if (firstFrame === -1) return stack;
  const keep = firstFrame + MAX_STACK_FRAMES;
  if (lines.length <= keep) return stack;
  return [
    ...lines.slice(0, keep),
    `    … ${lines.length - keep} more frame${lines.length - keep === 1 ? '' : 's'}`,
  ].join('\n');
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Render one debug payload. Errors don't survive `JSON.stringify`, so they're
 * flattened here, each `Error` to one object for the whole render so
 * `safe-stable-stringify` still renders a cycle as `"[Circular]"`.
 *
 * A plain payload's `Error`-valued fields render after its other fields, each
 * group in sorted key order. The sink bounds the rendered string, and a stack
 * sorted ahead of `runId` or `key` would otherwise spend that budget and cut
 * the fields that identify what failed.
 */
export function formatLogData(data: unknown): string {
  if (typeof data !== 'object' || data === null) return String(data);
  const flattened = new WeakMap<Error, Record<string, unknown>>();
  // `splitRoot` is the payload a split render copied its fields out of. Each
  // half is a fresh object, so the payload itself is never on the
  // stringifier's stack; a field that reaches it again is a cycle, rendered
  // as `"[Circular]"` exactly as an unsplit render would.
  const render = (value: unknown, splitRoot?: object): string =>
    safeStringify(
      value,
      (_key, field) => {
        if (field === splitRoot) return '[Circular]';
        return field instanceof Error ? flattenError(field, flattened) : field;
      },
      2,
    ) ?? String(value);
  if (!isPlainObject(data)) return render(data);
  const fields = Object.entries(data);
  const errorFields = fields.filter(([, field]) => field instanceof Error);
  if (errorFields.length === 0) return render(data);
  const head = render(
    Object.fromEntries(fields.filter(([, field]) => !(field instanceof Error))),
    data,
  );
  const tail = render(Object.fromEntries(errorFields), data);
  if (head === '{}') return tail;
  // Both halves are indented objects at the same depth: drop the head's
  // closing `\n}` and the tail's opening `{\n`, and join the field lists.
  return `${head.slice(0, -2)},\n${tail.slice(2)}`;
}
