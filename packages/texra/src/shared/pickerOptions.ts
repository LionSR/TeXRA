/**
 * Model picker rows as the hosts send them to their views. Kept free of
 * any IPC message wrappers so the message modules can compose these
 * without circular dependencies.
 */
import { Schema } from 'effect';
import {
  DeclinableUsageRouteSchema,
  ModelAvailabilityKindSchema,
} from '@texra-ai/worldline/schemas';

/**
 * Resolved per-model access. Computed once by `readModelOptions` and
 * shared verbatim across hosts (CLI picker, extension Models tab) so
 * availability and routing are never re-derived at render time: the kind,
 * why it cannot run and the subscription that pays are the whole verdict,
 * and `MODEL_AVAILABILITY_STATUS` reads the kind.
 */
export const ModelAvailabilityFieldsSchema = Schema.Struct({
  availability: ModelAvailabilityKindSchema,
  /** Why it cannot run now, worded as a run would fail; absent when it can. */
  unavailableReason: Schema.optional(Schema.String),
  /** The subscription paying for the next request; absent means own keys. */
  usageRoute: Schema.optional(DeclinableUsageRouteSchema),
  /** Effective request route for a model that can use multiple backends. */
  routeLabel: Schema.optional(Schema.String),
});
/** A model picker row: the opaque `value` sent back to the host, the
 *  `label` shown, and what the row says about the model. */
export const ModelOptionDataSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  provider: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  /** Current reasoning setting, including default or fixed-mode context. */
  reasoning: Schema.optional(Schema.String),
  ...ModelAvailabilityFieldsSchema.fields,
});
export type ModelOptionData = typeof ModelOptionDataSchema.Type;
