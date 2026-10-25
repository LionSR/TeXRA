import { Schema, SchemaGetter } from 'effect';

/** Absent and null legacy fields are both accepted; a present value is
 *  still checked. The decoded entry drops the nulls. */
const nullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

const NonnegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const UsageRouteSchema = Schema.Literals([
  'chatgpt-subscription',
  'glm-coding-plan-subscription',
  'kimi-code-subscription',
  'xai-subscription',
  'api-key',
  // LEGACY: relay wire tolerance. Released 0.40.x clients still post
  // `usageRoute: 'relay'` alongside `usedRelay: true`. Retirement is owned
  // by #10921: after 2026-11, and only once the ops drain (#10920) has
  // completed.
  'relay',
]);
const AgentCategorySchema = Schema.Literals(['workflow', 'toolUse']);
/** A UTC ISO 8601 date-time (`Z` only, seconds required, fraction optional)
 *  on a real calendar date: the pattern `z.iso.datetime()` checked, kept so
 *  the edge accepts exactly what it accepted before. */
const IsoDateTime = Schema.String.check(
  Schema.isPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/,
    { expected: 'a UTC ISO 8601 date-time' },
  ),
);

const requiredFields = {
  timestamp: IsoDateTime,
  model: Schema.String,
  /** The wire surface of the turn (`openai-responses`, `anthropic-messages`,
   *  `openrouter-chat`, ...), stored verbatim in the `provider` column. From
   *  TeXRA 1.0 the client sends protocol names where it used to send vendor
   *  names (`openai`, `anthropic`); the column is an external contract
   *  versioned with this function, so it stays a plain string and rows
   *  written by earlier clients keep their vendor names. */
  provider: Schema.String,
  inputTokens: NonnegativeInt,
  outputTokens: NonnegativeInt,
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
};

const optionalFields = {
  agentName: Schema.String,
  agentCategory: AgentCategorySchema,
  responseTimeMs: NonnegativeInt,
  cachedInputTokens: NonnegativeInt,
  reasoningTokens: NonnegativeInt,
  usageRoute: UsageRouteSchema,
  /** LEGACY: relay wire tolerance. Released clients still post this field and
   *  `index.ts` still writes the `used_relay` column from it. Retirement is
   *  owned by #10921: after 2026-11, and only once the ops drain (#10920) has
   *  completed. */
  usedRelay: Schema.Boolean,
  streamId: Schema.String,
  extensionVersion: Schema.String,
  editorType: Schema.String,
};

const UsageLogEntryInputSchema = Schema.Struct({
  ...requiredFields,
  agentName: nullable(optionalFields.agentName),
  agentCategory: nullable(optionalFields.agentCategory),
  responseTimeMs: nullable(optionalFields.responseTimeMs),
  cachedInputTokens: nullable(optionalFields.cachedInputTokens),
  reasoningTokens: nullable(optionalFields.reasoningTokens),
  usageRoute: nullable(optionalFields.usageRoute),
  usedRelay: nullable(optionalFields.usedRelay),
  viaChatGptSubscription: nullable(Schema.Boolean),
  streamId: nullable(optionalFields.streamId),
  extensionVersion: nullable(optionalFields.extensionVersion),
  editorType: nullable(optionalFields.editorType),
});

const UsageLogEntryOutputSchema = Schema.Struct({
  ...requiredFields,
  agentName: Schema.optional(optionalFields.agentName),
  agentCategory: Schema.optional(optionalFields.agentCategory),
  responseTimeMs: Schema.optional(optionalFields.responseTimeMs),
  cachedInputTokens: Schema.optional(optionalFields.cachedInputTokens),
  reasoningTokens: Schema.optional(optionalFields.reasoningTokens),
  usageRoute: Schema.optional(optionalFields.usageRoute),
  usedRelay: Schema.optional(optionalFields.usedRelay),
  streamId: Schema.optional(optionalFields.streamId),
  extensionVersion: Schema.optional(optionalFields.extensionVersion),
  editorType: Schema.optional(optionalFields.editorType),
});

/** One usage row: nulls dropped, and the legacy `viaChatGptSubscription`
 *  flag folded into `usageRoute`. */
export const UsageLogEntrySchema = UsageLogEntryInputSchema.pipe(
  Schema.decodeTo(UsageLogEntryOutputSchema, {
    decode: SchemaGetter.transform(({ viaChatGptSubscription, ...entry }) => {
      const present = Object.fromEntries(
        Object.entries(entry).filter(([, value]) => value !== null),
      ) as { [K in keyof typeof entry]: Exclude<(typeof entry)[K], null> }; // cast: the filter removed every null
      return {
        ...present,
        usageRoute:
          present.usageRoute ??
          (viaChatGptSubscription ? 'chatgpt-subscription' : undefined),
      };
    }),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

export const UsageBatchSchema = Schema.Struct({
  // The client drains at most its 1000-entry queue per flush; callers may now
  // be anonymous, so a batch is bounded at that size.
  entries: Schema.Array(UsageLogEntrySchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
  ),
  batchId: Schema.String.check(Schema.isUUID()),
});

export type UsageLogEntry = typeof UsageLogEntrySchema.Type;
export type UsageBatch = typeof UsageBatchSchema.Type;

/** Return the subscription product for subscription-backed usage. */
export function subscriptionSourceForUsage(
  entry: Pick<UsageLogEntry, 'usageRoute'>,
): string | undefined {
  switch (entry.usageRoute) {
    case 'chatgpt-subscription':
      return 'chatgpt';
    case 'kimi-code-subscription':
      return 'kimi';
    case 'glm-coding-plan-subscription':
      return 'glm';
    case 'xai-subscription':
      // Product name, matching chatgpt/kimi/glm — not the provider id `xai`.
      return 'grok';
    default:
      return undefined;
  }
}
