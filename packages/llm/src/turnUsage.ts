/**
 * A turn's token counts as the provider reported them, with the counts only
 * one provider reports kept under its own name. An unknown count stays null.
 */
import { Schema } from 'effect';

/** A non-negative integer: a token count. */
const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A turn's token counts as the provider reported them; unknown stays null. */
export const TurnUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(CountSchema),
  outputTokens: Schema.NullOr(CountSchema),
  totalTokens: Schema.NullOr(CountSchema),
  cachedInputTokens: Schema.NullOr(CountSchema),
  reasoningTokens: Schema.NullOr(CountSchema),
  providerUsage: Schema.optional(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('google'),
        /** Reported tool-use prompt count; absence does not mean zero. */
        toolUsePromptTokens: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('xai'),
        costInUsdTicks: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('anthropic'),
        uncachedInputTokens: Schema.NullOr(CountSchema),
        cacheCreationTokens: Schema.NullOr(CountSchema),
        cacheCreation5mTokens: Schema.NullOr(CountSchema),
        cacheCreation1hTokens: Schema.NullOr(CountSchema),
      }),
      Schema.Struct({
        kind: Schema.Literal('openrouter'),
        cost: Schema.optional(Schema.NullOr(Schema.Number)),
        isByok: Schema.optional(Schema.Boolean),
        inputDetails: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              cacheWriteTokens: Schema.optional(Schema.NullOr(CountSchema)),
            }),
          ),
        ),
      }),
    ]),
  ),
});
/** {@link TurnUsageSchema}'s value. */
export type TurnUsage = typeof TurnUsageSchema.Type;
