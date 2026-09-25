// Third-party imports
import { Data, Effect } from 'effect';
import { z } from 'zod';

// Local imports - canonical protocol binding
import {
  EditorOriginSchema,
  OriginSchema,
  sameModelOrigin,
  type ModelOrigin,
} from './protocol.js';

// Local imports - canonical messages
import {
  MiniMaxDetectionSchema,
  OpenRouterFileAnnotationSchema,
} from './message.js';

/** Enough evidence to observe accepted remote work, without a second transcript. */
const ResponsesOperationSchema = z
  .strictObject({
    origin: OriginSchema.extend({
      protocol: z.literal('openai-responses'),
    }).readonly(),
    providerResponseId: z.string().min(1),
    afterSequence: z.int().nonnegative().nullable(),
    /**
     * The inputs the provider was given, hashed by the same function a
     * continuation's prefix fingerprint uses: origin, system text and the
     * admitted history. A resume rebuilds the turn from the caller's current
     * system text, so an observation compares this digest before it lets the
     * completion leave an anchor the next round would chain on. A digest is
     * not a transcript: the handle still carries no history.
     */
    admittedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * The storage mode the turn was admitted under. An observation re-prepares
     * with this rather than the current setting: a temporary background
     * response leaves nothing to chain on, so re-preparing it as stored would
     * mint an anchor for a response the provider never kept.
     */
    store: z.boolean(),
  })
  .readonly();
export const RemoteOperationSchema = z.union([
  ResponsesOperationSchema,
  ResponsesOperationSchema.unwrap()
    .extend({
      origin: OriginSchema.extend({
        protocol: z.literal('google-interactions'),
      }).readonly(),
      // Polling snapshots have no provider sequence or replay cursor.
      afterSequence: z.null(),
    })
    .readonly(),
]);
export type RemoteOperation = z.infer<typeof RemoteOperationSchema>;

const ModelErrorFieldsSchema = z.strictObject({
  kind: z.enum([
    'invalid-request',
    'unsupported',
    'authentication',
    'transport',
    'provider-rejection',
    'malformed-output',
    'observation-deadline',
  ]),
  message: z.string(),
  requestId: z.string().optional(),
  responseId: z.string().optional(),
  model: z.string().optional(),
  status: z.int().optional(),
  /**
   * The provider's own "come back in" delay, in milliseconds, as its
   * response stated it. The retry gate reads this instead of guessing a
   * backoff, so a rate limit waits exactly as long as it was told to.
   */
  retryAfterMs: z.int().nonnegative().optional(),
  operation: RemoteOperationSchema.optional(),
  providerEvidence: z
    .discriminatedUnion('kind', [
      MiniMaxDetectionSchema.extend({
        kind: z.literal('minimax'),
        origin: OriginSchema.extend({
          protocol: z.literal('minimax-chat'),
        }).readonly(),
        statusCode: z.int(),
        statusMessage: z.string().optional(),
      }).readonly(),
      z
        .strictObject({
          kind: z.literal('openrouter'),
          origin: OriginSchema.extend({
            protocol: z.literal('openrouter-chat'),
          }).readonly(),
          fileAnnotations: z.array(OpenRouterFileAnnotationSchema).readonly(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('vscode-lm'),
          origin: EditorOriginSchema.readonly(),
          code: z.enum(['NoPermissions', 'Blocked', 'NotFound']),
        })
        .readonly(),
    ])
    .optional(),
});
/** Typed provider failure. Fiber interruption remains outside this channel. */
export class ModelError extends Data.TaggedError('ModelError')<
  z.infer<typeof ModelErrorFieldsSchema> & { readonly cause?: unknown }
> {}

/** The operation `input` names, provided it belongs to the `origin` binding. */
export const boundOperation = Effect.fn('llm.boundOperation')(function* (
  input: RemoteOperation,
  origin: ModelOrigin,
) {
  const parsed = RemoteOperationSchema.safeParse(input);
  if (!parsed.success || !sameModelOrigin(parsed.data.origin, origin))
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The remote operation belongs to another model binding.',
    });
  return parsed.data;
});

/**
 * What a cancel reply's status says about the work: `cancelled` confirms it,
 * a queued or running status leaves it unconfirmed, and any other status is
 * the terminal outcome it reached first, bounded by the cancellation
 * evidence schema the caller parses this into.
 */
export const cancellationStatus = (status: string) =>
  status === 'cancelled'
    ? { kind: 'confirmed-cancelled' as const }
    : {
        kind:
          status === 'queued' || status === 'in_progress'
            ? ('unconfirmed' as const)
            : ('observed-terminal' as const),
        status,
      };

/**
 * Rebuild a `ModelError` with `patch` applied over the fields it already
 * carries. `message` and `cause` live on `Error` as own non-enumerable
 * properties, so the spread that carries every other field silently drops
 * both; restating them keeps a re-thrown error's text and origin.
 *
 * `patch` is spread last, so one of its keys wins even when its value is
 * `undefined`: a computed `requestId: undefined` erases the id the failure
 * mapping already read. Pass only the keys the call site observed.
 */
export const enrichModelError = (
  error: ModelError,
  patch: Partial<
    z.infer<typeof ModelErrorFieldsSchema> & { readonly cause?: unknown }
  >,
): ModelError =>
  new ModelError({
    ...error,
    message: error.message,
    cause: error.cause,
    ...patch,
  });

/**
 * Every provider's failure mapping treats HTTP 401/403 (or the equivalent
 * error code carried in a rejection body) as `authentication` and anything
 * else the provider rejected as `provider-rejection`. Pass every status-like
 * value a given failure carries; the numbers `401`/`403` match, matching the
 * prior per-provider checks this replaces — a status carried as a string
 * (e.g. OpenRouter's `error.code`, typed `string | number`) never matches,
 * same as before this helper existed.
 */
export const authOrRejectionKind = (
  ...statuses: ReadonlyArray<number | string | undefined>
): 'authentication' | 'provider-rejection' =>
  statuses.some((status) => status === 401 || status === 403)
    ? 'authentication'
    : 'provider-rejection';

/**
 * Parses JSON out of provider stream/error text, mapping a parse failure to
 * the caller's own `ModelError` instead of throwing a raw `SyntaxError`.
 */
export const parseJsonOrModelError = (
  text: string,
  onMalformed: (cause: unknown) => ModelError,
): Effect.Effect<unknown, ModelError> =>
  Effect.try({ try: () => JSON.parse(text) as unknown, catch: onMalformed });

/** True when a parsed provider payload embeds an `{ error }` field. */
export const hasErrorField = (value: unknown): value is { error: unknown } =>
  typeof value === 'object' && value !== null && 'error' in value;

/**
 * The delay one response asks the caller to wait, in milliseconds:
 * `retry-after-ms` where the provider sends it, else `retry-after` as
 * seconds or as an HTTP date. Undefined when the response says nothing —
 * the caller's own backoff then owns the wait.
 */
export function retryAfterMsOf(
  headers: Headers | undefined,
): number | undefined {
  // `Number('')` and `Number(null)` are both 0, so an absent header has to be
  // recognised as absent before it is read as a delay of zero.
  const read = (name: string): string | undefined => {
    const value = headers?.get(name);
    return value === null || value === undefined || value.trim() === ''
      ? undefined
      : value.trim();
  };
  const explicit = read('retry-after-ms');
  if (explicit !== undefined) {
    const ms = Number(explicit);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  const retryAfter = read('retry-after');
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
