/**
 * Picker option rows (models, agents) as the hosts send them to their
 * views. Kept free of any IPC message wrappers so the message modules can
 * compose these without circular dependencies.
 */
import { Schema, Struct } from 'effect';
import {
  agentName,
  AgentSourceSchema,
  DeclinableUsageRouteSchema,
  ModelAvailabilityKindSchema,
} from '@texra-ai/harness/schemas';

/**
 * Shared base for picker option rows (`<wa-select>`-style entries). Both the
 * model and agent picker shapes carry an opaque `value` (the id sent back to
 * the host) and a user-facing `label`. Consolidating this base via `.extend()`
 * keeps the two field names in lockstep — historically a typo in either schema
 * would have silently broken option matching in only one picker.
 */
const PickerOptionBaseSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

/**
 * Resolved per-model access. Computed once by `readModelOptions` and
 * shared verbatim across hosts (CLI picker, extension Models tab) so
 * availability and routing are never re-derived at render time: the kind and
 * the subscription that pays are the whole verdict, and
 * `MODEL_AVAILABILITY_STATUS` reads the kind.
 */
export const ModelAvailabilityFieldsSchema = Schema.Struct({
  availability: ModelAvailabilityKindSchema,
  /** The subscription paying for the next request; absent means own keys. */
  usageRoute: Schema.optional(DeclinableUsageRouteSchema),
  /** Effective request route for a model that can use multiple backends. */
  routeLabel: Schema.optional(Schema.String),
});
export const ModelOptionDataSchema = PickerOptionBaseSchema.mapFields(
  Struct.assign({
    provider: Schema.optional(Schema.String),
    context: Schema.optional(Schema.String),
    cost: Schema.optional(Schema.String),
    hint: Schema.optional(Schema.String),
    /** Current reasoning setting, including default or fixed-mode context. */
    reasoning: Schema.optional(Schema.String),
    ...ModelAvailabilityFieldsSchema.fields,
  }),
);
export type ModelOptionData = typeof ModelOptionDataSchema.Type;

export const AgentOptionDataSchema = PickerOptionBaseSchema.mapFields(
  Struct.assign({
    isOrchestrator: Schema.optional(Schema.Boolean),
    /** Provenance, in the canonical agent vocabulary rather than one-hot flags. */
    source: Schema.optional(AgentSourceSchema),
  }),
);
export type AgentOptionData = typeof AgentOptionDataSchema.Type;

/**
 * Whether an agent option's `value` (a source-qualified key) is the agent
 * `keyOrName` names. A key names one agent exactly, so a same-named agent of
 * another source is not it; a bare name (an older launch, a proposal with no
 * source) names the agent of that name from any source.
 */
export function isAgentOption(value: string, keyOrName: string): boolean {
  return (
    value === keyOrName ||
    (agentName(keyOrName) === keyOrName && agentName(value) === keyOrName)
  );
}
