// Third-party imports
import { Schema, Struct } from 'effect';

/**
 * Scheme, host and path only. The origin is written into durable rows that
 * are never scrubbed, and a URL check alone admits `user:key@host`,
 * `?api-key=` and `#api-key=` alike.
 */
const EndpointSchema = Schema.String.check(
  Schema.makeFilter(
    (endpoint) => {
      if (!URL.canParse(endpoint)) return 'Expected a URL';
      const url = new URL(endpoint);
      return (
        url.username === '' && url.password === '' && !/[?#]/.test(endpoint)
      );
    },
    { message: 'Endpoints carry no userinfo, query string or fragment.' },
  ),
);
export const BindingSchema = Schema.Struct({
  requestedModel: Schema.String.check(Schema.isMinLength(1)),
  deployment: Schema.Struct({
    endpoint: EndpointSchema,
    credentialScope: Schema.String.check(Schema.isMinLength(1)),
  }),
});
/**
 * Every wire surface the package speaks. Usage is billed per surface, so a
 * usage record's provider is the protocol of the turn that produced it.
 */
export const TurnProtocolSchema = Schema.Literals([
  'google-interactions',
  'openai-responses',
  'anthropic-messages',
]);

/** Selected binding, distinct from an optional returned model version. */
export const ModelOriginSchema = BindingSchema.mapFields(
  Struct.assign({
    protocol: TurnProtocolSchema,
    /**
     * What the provider-specific state a turn stores means (reasoning
     * signatures, encrypted reasoning, provider evidence). It changes only
     * when a codec would read that stored state differently; adding a field
     * or changing how a request is built keeps it. A stored turn of another
     * version decodes, and is not the same origin (`sameModelOrigin`), so it
     * is sent as plain content without its reasoning and evidence, as after
     * a model switch. This build writes the version `originOf` stamps. A
     * change to the stored shape of that state, one an older build could
     * not decode, bumps the store's row version instead.
     */
    codecVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
);
/** The binding a turn was requested on: model, deployment and protocol. */
export type ModelOrigin = typeof ModelOriginSchema.Type;

/** The origin a wire model stamps on its turns: the one place `codecVersion` is written. */
export const originOf = <P extends ModelOrigin['protocol']>(
  config: Pick<ModelOrigin, 'requestedModel' | 'deployment'> & {
    readonly protocol: P;
  },
) =>
  Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1 as const,
  });

/** Compares the complete non-secret binding, not runtime lineage. A `null`
 *  left side (content no model produced) matches no binding. */
export function sameModelOrigin(
  left: ModelOrigin | null,
  right: ModelOrigin,
): boolean {
  if (
    left === null ||
    left.protocol !== right.protocol ||
    left.codecVersion !== right.codecVersion ||
    left.requestedModel !== right.requestedModel
  ) {
    return false;
  }
  return (
    left.deployment.endpoint === right.deployment.endpoint &&
    left.deployment.credentialScope === right.deployment.credentialScope
  );
}

function hasSupportedJsonKeys(
  value: unknown,
  parents = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (parents.has(value) || Object.hasOwn(value, '__proto__')) return false;
  parents.add(value);
  const valid = Object.values(value).every((nested) =>
    hasSupportedJsonKeys(nested, parents),
  );
  parents.delete(value);
  return valid;
}

/** Materialized JSON: a string-keyed object of JSON values. */
export const JsonObjectSchema = Schema.Unknown.check(
  Schema.makeFilter((value) => hasSupportedJsonKeys(value), {
    message:
      'JSON cannot contain cycles or __proto__ keys, which this codec cannot preserve.',
  }),
).pipe(Schema.decodeTo(Schema.JsonObject));

/** A non-negative integer: a token or item count. */
export const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A turn's token counts as reported; an unknown count stays null. Only what
 *  no neutral count holds is `providerUsage`: an xAI receipt's cost, and
 *  Anthropic's uncached input count and 5m/1h split of its cache writes. */
export const TurnUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(CountSchema),
  outputTokens: Schema.NullOr(CountSchema),
  totalTokens: Schema.NullOr(CountSchema),
  /** Prompt tokens read from the provider's cache. */
  cachedInputTokens: Schema.NullOr(CountSchema),
  /** Prompt tokens written to the provider's cache (Anthropic). */
  cacheWriteTokens: Schema.NullOr(CountSchema),
  reasoningTokens: Schema.NullOr(CountSchema),
  /** Prompt tokens a provider-run tool added (Google). */
  toolUsePromptTokens: Schema.NullOr(CountSchema),
  providerUsage: Schema.optional(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('xai'),
        costInUsdTicks: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('anthropic'),
        uncachedInputTokens: Schema.NullOr(CountSchema),
        cacheCreation5mTokens: Schema.NullOr(CountSchema),
        cacheCreation1hTokens: Schema.NullOr(CountSchema),
      }),
    ]),
  ),
});
/** {@link TurnUsageSchema}'s value. */
export type TurnUsage = typeof TurnUsageSchema.Type;
