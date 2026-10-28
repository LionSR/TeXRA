/**
 * Picker option rows (models, agents, teams) as the hosts send them to their
 * views. Kept free of any IPC message wrappers so the message modules can
 * compose these without circular dependencies.
 */
import { Effect, Schema, Struct } from 'effect';

import {
  AgentSourceSchema,
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
 * availability and routing are never re-derived at render time: the kind is
 * the whole verdict, and `MODEL_AVAILABILITY_STATUS` reads it.
 */
export const ModelAvailabilityFieldsSchema = Schema.Struct({
  availability: Schema.optional(ModelAvailabilityKindSchema),
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
 * Team picker option row for the main-view "Run with: Team" target. `value`
 * carries the preset id (a built-in team or a user-saved custom one); hosts
 * resolve the agent list, so the renderer only ever sends team identity back.
 * Availability is resolved against the full live catalog, not just the
 * workspace's enabled agents.
 */
export const TeamOptionDataSchema = PickerOptionBaseSchema.mapFields(
  Struct.assign({
    /** Provenance uses the shared `'built-in' | 'custom'` team vocabulary. */
    source: Schema.Literals(['built-in', 'custom']),
    /** The team's icon, a name the host's icon set draws. */
    icon: Schema.String,
    /** Preset description, surfaced as the option `title`. */
    description: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed('')),
    ),
    /** Catalog members that did not resolve; empty means fully runnable. */
    unavailableMembers: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
    /** Marks "no runnable team lead"; `disabledReason` carries the human explanation. */
    disabled: Schema.optional(Schema.Boolean),
    disabledReason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type TeamOptionData = typeof TeamOptionDataSchema.Type;
