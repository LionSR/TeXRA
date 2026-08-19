import { z } from 'zod';

/** Normalize absent/null legacy fields while rejecting malformed present values. */
function optional<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .transform((value): z.infer<T> | undefined => value ?? undefined);
}

const optionalString = optional(z.string());
const optionalNonnegativeInt = optional(z.int().nonnegative());
const optionalBoolean = optional(z.boolean());
const UsageRouteSchema = z.enum([
  'chatgpt-subscription',
  'glm-coding-plan-subscription',
  'kimi-code-subscription',
  'xai-subscription',
  // 'relay' and `usedRelay` below are legacy wire tolerance: relay producers
  // were removed 2026-08 (docs/proposals/2026-08-18-relay-removal-and-recovery.md)
  // but released clients still report them. Delete after 2026-11.
  'relay',
  'api-key',
]);

const UsageLogEntryInputSchema = z.object({
  timestamp: z.iso.datetime(),
  model: z.string(),
  provider: z.string(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cost: z.number().nonnegative(),
  agentName: optionalString,
  agentCategory: optional(z.enum(['workflow', 'toolUse'])),
  isMultipleOutput: optionalBoolean,
  responseTimeMs: optionalNonnegativeInt,
  cachedInputTokens: optionalNonnegativeInt,
  reasoningTokens: optionalNonnegativeInt,
  usedRelay: optionalBoolean,
  usageRoute: optional(UsageRouteSchema),
  viaChatGptSubscription: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  // The destination mapper supplies `chatgpt` for legacy subscription entries
  // that predate an explicit source.
  subscriptionSource: optionalString,
  streamId: optionalString,
  extensionVersion: optionalString,
  editorType: optionalString,
});

export const UsageLogEntrySchema = UsageLogEntryInputSchema.transform(
  ({ viaChatGptSubscription, ...entry }) => ({
    ...entry,
    usageRoute:
      entry.usageRoute ??
      (viaChatGptSubscription ? 'chatgpt-subscription' : undefined),
  }),
);

export const UsageBatchSchema = z.object({
  entries: z.array(UsageLogEntrySchema).min(1),
  batchId: z.uuid(),
});

export type UsageLogEntry = z.infer<typeof UsageLogEntrySchema>;

/** Return the subscription product for subscription-backed usage. */
export function subscriptionSourceForUsage(
  entry: Pick<UsageLogEntry, 'usageRoute' | 'subscriptionSource'>,
): string | undefined {
  switch (entry.usageRoute) {
    case 'chatgpt-subscription':
      return entry.subscriptionSource ?? 'chatgpt';
    case 'kimi-code-subscription':
      return entry.subscriptionSource ?? 'kimi';
    case 'glm-coding-plan-subscription':
      return entry.subscriptionSource ?? 'glm';
    case 'xai-subscription':
      // Product name, matching chatgpt/kimi/glm — not the provider id `xai`.
      return entry.subscriptionSource ?? 'grok';
    default:
      return undefined;
  }
}
