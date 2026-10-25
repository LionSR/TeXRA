/**
 * Picker option rows (models, agents, teams) and their availability.
 * Kept free of any IPC message wrappers so the message modules can compose
 * these without circular dependencies.
 */
import { Effect, Schema, Struct } from 'effect';

import { AgentSourceSchema } from '@shared/schemas/agent';
import { SUBSCRIPTION_AUTH_NAMES } from '@shared/model/subscriptionAuth';

// ============================================================
// Option Data Schemas
// ============================================================

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

const ModelAvailabilityKindSchema = Schema.Literals([
  'provider-key',
  'openrouter-key',
  'missing-key',
  // The provider's key is stored, or may be, but the secret store could not
  // be read: not a missing key, so never worded as one.
  'key-unreadable',
  'retired',
  // ChatGPT-subscription (Codex) access via the user's own OAuth session.
  'subscription-access',
  // The same, on the user's Grok (xAI) subscription.
  'xai-subscription-access',
  // Editor-hosted Copilot access is keyless but distinct from ChatGPT.
  // Permission state is reported by the VS Code host, and each kind below is
  // `copilot-` + that host port's own access word
  // (`LanguageModelAccessState`): the wire states the fact once, and
  // `computeModelOptions` builds the kind from the word rather than
  // translating between two vocabularies.
  'copilot-allowed',
  'copilot-consent-required',
  'copilot-unavailable',
  'provider-unavailable',
  // The model id survives in a host's enabled-models list but the live
  // registry no longer describes it, so nothing can route a request for it.
  'unknown-model',
]);
/** Why a model option can or cannot run. */
export type ModelAvailabilityKind = typeof ModelAvailabilityKindSchema.Type;

/**
 * What a kind means: the label a surface shows for it, whether a run can use
 * the model, and whether the block is a missing key. Declared once here, next
 * to the kind, so the answer is carried on the wire as the kind alone and
 * every host reads the same table instead of four pre-fanned fields.
 *
 * Written with `as const satisfies` so each `available` literal survives for
 * `computeModelOptions`'s derivation of the unavailable kinds, while a missing
 * or misshapen kind is still a compile error, and frozen to the depth it is
 * read at: the table crosses into every host that decides whether a model can
 * run, and `readonly` is compile-time only.
 */
export const MODEL_AVAILABILITY_STATUS = {
  'openrouter-key': {
    label: 'OpenRouter key',
    available: true,
    requiresKey: false,
  },
  'provider-key': { label: 'API key set', available: true, requiresKey: false },
  'missing-key': {
    label: 'Missing API key',
    available: false,
    requiresKey: true,
  },
  'key-unreadable': {
    label: 'API key unreadable',
    available: false,
    requiresKey: false,
  },
  'subscription-access': {
    label: SUBSCRIPTION_AUTH_NAMES.chatgpt.subscriptionLabel,
    available: true,
    requiresKey: false,
  },
  'xai-subscription-access': {
    label: SUBSCRIPTION_AUTH_NAMES.grok.subscriptionLabel,
    available: true,
    requiresKey: false,
  },
  'copilot-allowed': {
    label: 'Copilot subscription',
    available: true,
    requiresKey: false,
  },
  'copilot-consent-required': {
    label: 'Copilot approval required',
    available: false,
    requiresKey: false,
  },
  'copilot-unavailable': {
    label: 'Copilot unavailable',
    available: false,
    requiresKey: false,
  },
  // Only the OpenRouter route produces this kind (`computeModelOptions` maps
  // the decided `openrouter-unsupported` route to it), so the one label the
  // kind carries names that route.
  'provider-unavailable': {
    label: 'Unavailable through OpenRouter',
    available: false,
    requiresKey: false,
  },
  retired: { label: 'Retired', available: false, requiresKey: false },
  'unknown-model': {
    label: 'Unknown model',
    available: false,
    requiresKey: false,
  },
} as const satisfies Record<
  ModelAvailabilityKind,
  {
    readonly label: string;
    readonly available: boolean;
    readonly requiresKey: boolean;
  }
>;
for (const status of Object.values(MODEL_AVAILABILITY_STATUS))
  Object.freeze(status);
Object.freeze(MODEL_AVAILABILITY_STATUS);

/**
 * Resolved per-model access. Computed once by `readModelOptions` and
 * shared verbatim across hosts (CLI picker, extension Models tab) so
 * availability and routing are never re-derived at render time: the kind is
 * the whole verdict, and {@link MODEL_AVAILABILITY_STATUS} words it.
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

/**
 * Whether an option row can be run as shipped: `readModelOptions`
 * already resolved the access question, so a caller only has to read its
 * verdict. Lives with the type so delegation's model list and the CLI's
 * picker can never drift apart on what "available" means.
 */
export function isModelOptionAvailable(model: ModelOptionData): boolean {
  return (
    model.availability === undefined ||
    MODEL_AVAILABILITY_STATUS[model.availability].available
  );
}

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
 * carries the preset id (one of the built-ins in `AGENT_MODE_PRESETS` or a
 * user-saved custom team); hosts resolve the agent list, so the renderer only
 * ever sends team identity back. Availability is resolved against the full
 * live catalog, not just the workspace's enabled agents.
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
