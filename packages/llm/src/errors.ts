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

/** Enough evidence to observe accepted remote work, without a second transcript. */
const ResponsesOperationSchema = z
  .strictObject({
    origin: OriginSchema.extend({
      protocol: z.literal('openai-responses'),
    }).readonly(),
    providerResponseId: z.string().min(1),
    afterSequence: z.int().nonnegative().nullable(),
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

/** A subscription plan whose quota a request can exhaust, named by its route. */
const PlanRouteSchema = z.enum([
  'chatgpt-subscription',
  'xai-subscription',
  'kimi-code-subscription',
  'glm-coding-plan-subscription',
]);
/** A subscription plan, named by the route that bills through it. */
export type PlanRoute = z.infer<typeof PlanRouteSchema>;

/** A model failure's fields as data: what crosses a process boundary (an
 *  editor's model served to the service) and is rebuilt there as a
 *  {@link ModelError}. */
export const ModelErrorFieldsSchema = z.strictObject({
  kind: z.enum([
    'invalid-request',
    'unsupported',
    'authentication',
    'rate-limited',
    'quota-exhausted',
    'context-overflow',
    'continuation-gone',
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
  /** Whether repeating the request unchanged can succeed. */
  retryable: z.boolean(),
  /**
   * What the failure is evidence about beyond this request: `model` for a
   * limit the provider scoped to one model, `route` for the shared provider,
   * credential and endpoint (an unscoped rate limit, a server failure, the
   * network). Absent when it says nothing about either.
   */
  scope: z.enum(['model', 'route']).optional(),
  /**
   * The provider's own "come back in" delay, in milliseconds, as its
   * response stated it. The retry gate reads this instead of guessing a
   * backoff, so a rate limit waits exactly as long as it was told to.
   */
  retryAfterMs: z.int().nonnegative().optional(),
  /** What a `quota-exhausted` failure used up: a plan, or the account's credit (`plan: null`). */
  quota: z
    .strictObject({
      plan: PlanRouteSchema.nullable(),
      /** The plan's tier as the provider names it (ChatGPT's `pro`). */
      planType: z.string().optional(),
      resetsInMs: z.int().nonnegative().optional(),
    })
    .readonly()
    .optional(),
  operation: RemoteOperationSchema.optional(),
  providerEvidence: z
    .discriminatedUnion('kind', [
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
type ModelErrorFields = z.infer<typeof ModelErrorFieldsSchema> & {
  readonly cause?: unknown;
};

/** A server failure, a timeout, a conflict or a rate limit: worth repeating. */
const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 409 || status === 429;

/** Whether a failure of `kind` can succeed when repeated, absent other evidence. */
function retryableByDefault(
  kind: ModelErrorFields['kind'],
  status: number | undefined,
): boolean {
  switch (kind) {
    case 'transport':
    case 'rate-limited':
    case 'observation-deadline':
      return true;
    case 'provider-rejection':
    case 'malformed-output':
      return status === undefined || isRetryableStatus(status);
    case 'invalid-request':
    case 'unsupported':
    case 'authentication':
    case 'quota-exhausted':
    case 'context-overflow':
    case 'continuation-gone':
      return false;
  }
}

/**
 * Typed provider failure. Fiber interruption remains outside this channel.
 * `retryable` and `scope` default from the kind and status; the binding that
 * read the vendor's reply states them where the reply says more.
 */
export class ModelError extends Data.TaggedError(
  'ModelError',
)<ModelErrorFields> {
  constructor(
    fields: Omit<ModelErrorFields, 'retryable'> & {
      readonly retryable?: boolean;
    },
  ) {
    const { status } = fields;
    super({
      ...fields,
      retryable: fields.retryable ?? retryableByDefault(fields.kind, status),
      ...(fields.scope === undefined &&
      status !== undefined &&
      (status >= 500 || status === 408 || status === 429)
        ? { scope: 'route' as const }
        : {}),
    });
  }
}

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
 * A cancel reply's status, read as the one fact a caller acts on: only
 * `cancelled` confirms the work stopped. Any other status (still queued or
 * running, or a terminal outcome reached first) leaves the operation
 * observable, so it fails rather than let the caller retire it.
 */
export const confirmCancelled = (
  operation: RemoteOperation,
  status: string,
): Effect.Effect<void, ModelError> =>
  status === 'cancelled'
    ? Effect.void
    : Effect.fail(
        new ModelError({
          kind: 'provider-rejection',
          retryable: false,
          message: `The background response ${operation.providerResponseId} was not cancelled; it is ${status}.`,
        }),
      );

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
  patch: Partial<ModelErrorFields>,
): ModelError =>
  new ModelError({
    ...error,
    message: error.message,
    cause: error.cause,
    ...patch,
  });

/**
 * A `ModelError` completed with what an outer scope knows. A field the error
 * already carries is never overwritten: the scope nearest the failure, such
 * as the turn assembly that learned the returned model, recorded it first.
 */
export const fillModelError = (
  error: ModelError,
  known: Partial<ModelErrorFields>,
): ModelError =>
  enrichModelError(
    error,
    Object.fromEntries(
      Object.entries(known).filter(
        ([key, value]) =>
          value !== undefined && Reflect.get(error, key) === undefined,
      ),
    ),
  );

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
function retryAfterMsOf(headers: Headers | undefined): number | undefined {
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

/** The HTTP facts a provider SDK's error carries, when the failure had a reply. */
interface SdkHttpFailure {
  readonly status?: number;
  readonly headers?: Headers;
  readonly requestId?: string | null;
}

/**
 * The one classification of a provider SDK failure. A `SyntaxError` is
 * malformed output, a failure with an HTTP reply is an authentication or
 * provider rejection by its status, and anything else is transport. Each
 * protocol only extracts `http` from its own SDK's error type.
 */
export function sdkModelError(
  cause: unknown,
  http: SdkHttpFailure | undefined,
  fallbackMessage: string,
): ModelError {
  const retryAfterMs = retryAfterMsOf(http?.headers);
  let kind: ModelError['kind'] = 'transport';
  if (cause instanceof SyntaxError) kind = 'malformed-output';
  else if (http) kind = authOrRejectionKind(http.status);
  return new ModelError({
    kind,
    message: cause instanceof Error ? cause.message : fallbackMessage,
    ...(http?.status === undefined ? {} : { status: http.status }),
    ...(http?.requestId == null ? {} : { requestId: http.requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    cause,
  });
}
