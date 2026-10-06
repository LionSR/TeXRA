/**
 * MainView state and data schemas (option rows, banners, and file state).
 * Kept free of any IPC message wrappers so the message modules can compose
 * these without circular dependencies.
 */
import { z } from 'zod';

import { AgentSourceSchema } from '@shared/schemas/agent';
import { CHATGPT_AUTH, GROK_AUTH } from '@shared/model/accountAuth';
import {
  TEXRA_ICON_CANONICAL_NAMES,
  type TeXRAIconName,
} from '@shared/iconNames';
import { DocumentFileTypeSchema } from '../fileTypes';
import { ToolConfigFieldsSchema } from '../toolConfig';

// ============================================================
// Session Schemas
// ============================================================

/**
 * What the main view launches: a document task over the selected files, or
 * a chat with the selected agent.
 */
export const SessionTypeSchema = z.enum(['task', 'chat']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

/** Who runs a main-view request: a single agent or a team. */
export const LaunchTargetSchema = z.enum(['agent', 'team']);

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
const PickerOptionBaseSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const ModelAvailabilityKindSchema = z.enum([
  'provider-key',
  'openrouter-key',
  'missing-key',
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
export type ModelAvailabilityKind = z.infer<typeof ModelAvailabilityKindSchema>;

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
  'subscription-access': {
    label: CHATGPT_AUTH.subscriptionLabel,
    available: true,
    requiresKey: false,
  },
  'xai-subscription-access': {
    label: GROK_AUTH.subscriptionLabel,
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
 * Price-based "fast first response" hint: models strictly under $1/M input
 * are small, fast, cheap variants that make a reasonable first try. Pricing
 * is the one source of truth, which avoids the substring-match foot-guns of
 * earlier name-based versions (matching `gemini*`, `minimax*` by accident).
 * Capable mid-range models (Sonnet at $3/M) are deliberately not "fast" in
 * this latency sense.
 */
const FAST_FIRST_RESPONSE_PRICE_CEILING = 1;

/** Hint prepended to a fast model's picker tooltip. */
export const FAST_FIRST_RESPONSE_HINT =
  '⚡ Fast first response — try this for quick replies';

/**
 * Whether a model's input price qualifies it as a fast first-try pick.
 * Undefined prices (unpriced, local, custom) are not fast.
 */
export function isFastFirstResponseModel(
  inputPrice: number | undefined,
): boolean {
  return (
    inputPrice !== undefined && inputPrice < FAST_FIRST_RESPONSE_PRICE_CEILING
  );
}

/**
 * Models whose API pricing is high enough that the picker steers users to
 * the External Inquiry tool, which lets agents ask the user to paste an
 * answer from their own ChatGPT/Claude/Gemini subscription instead.
 *
 * The test is the output price, not the name: `gpt<digits>pro` once meant
 * "Pro tier", but `gpt56pro` ships at $4/$20 while `o1pro` ($150/$600) and
 * `o3pro` ($20/$80) never matched. The Pro tier (o3pro, gpt5pro … gpt55pro,
 * o1pro) plus gpt45 all price output at $80+ per 1M; the most expensive
 * flagship tier (Opus 4/4.1) tops out at $75, so $80 separates the two.
 */
const EXPENSIVE_OUTPUT_PRICE_FLOOR = 80;

/** Hint prepended to an expensive model's picker tooltip, and its badge. */
export const EXPENSIVE_MODEL_HINT =
  '💸 Premium API pricing — consider the External Inquiry tool to use your own ChatGPT/Claude subscription instead';

/**
 * Whether API use of a model is expensive enough to warn about. Undefined
 * prices (unpriced, local, custom) are not expensive.
 */
export function isExpensiveModel(outputPrice: number | undefined): boolean {
  return (
    outputPrice !== undefined && outputPrice >= EXPENSIVE_OUTPUT_PRICE_FLOOR
  );
}

/**
 * Resolved per-model access. Computed once by `modelOptionsFrom` and
 * shared verbatim across hosts (CLI picker, extension Models tab) so
 * availability and routing are never re-derived at render time: the kind is
 * the whole verdict, and {@link MODEL_AVAILABILITY_STATUS} words it.
 */
export const ModelAvailabilityFieldsSchema = z.object({
  availability: ModelAvailabilityKindSchema.optional(),
  /** Effective request route for a model that can use multiple backends. */
  routeLabel: z.string().optional(),
});
export const ModelOptionDataSchema = PickerOptionBaseSchema.extend({
  provider: z.string().optional(),
  context: z.string().optional(),
  cost: z.string().optional(),
  hint: z.string().optional(),
  /** Current reasoning setting, including default or fixed-mode context. */
  reasoning: z.string().optional(),
  ...ModelAvailabilityFieldsSchema.shape,
});
export type ModelOptionData = z.infer<typeof ModelOptionDataSchema>;

/**
 * Whether an option row can be run as shipped: `modelOptionsFrom`
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

export const AgentOptionDataSchema = PickerOptionBaseSchema.extend({
  isOrchestrator: z.boolean().optional(),
  /** Provenance, in the canonical agent vocabulary rather than one-hot flags. */
  source: AgentSourceSchema.optional(),
  /** A document task's revision count (the header's "Pass 2 of 3"):
   *  present exactly when the agent is also a document task. */
  rounds: z.int().positive().optional(),
});
export type AgentOptionData = z.infer<typeof AgentOptionDataSchema>;

/** Open workspace folder offered as a run working directory. */
export const WorkspaceRootOptionDataSchema = PickerOptionBaseSchema;

/**
 * Team picker option row for the main-view "Run with: Team" target. `value`
 * carries the preset id (one of the built-ins in `AGENT_MODE_PRESETS` or a
 * user-saved custom team); hosts resolve the agent list, so the renderer only
 * ever sends team identity back. Availability is resolved against the full
 * live catalog, not just the workspace's enabled agents.
 */
export const TeamOptionDataSchema = PickerOptionBaseSchema.extend({
  /** Provenance uses the shared `'built-in' | 'custom'` team vocabulary. */
  source: z.enum(['built-in', 'custom']),
  /** Web Awesome icon name registered in `packages/harness/src/shared/iconNames.ts`. */
  icon: z.string(),
  /** Preset description, surfaced as the option `title`. */
  description: z.string().prefault(''),
  /** Catalog members that did not resolve; empty means fully runnable. */
  unavailableMembers: z.array(z.string()).prefault([]),
  /** Marks "no runnable team lead"; `disabledReason` carries the human explanation. */
  disabled: z.boolean().optional(),
  disabledReason: z.string().nullish(),
});
export type TeamOptionData = z.infer<typeof TeamOptionDataSchema>;

// ============================================================
// Banner Data Schemas
// ============================================================

export const AgentConfigBannerDataSchema = z.object({
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});

/**
 * One missing dependency as the host reports it: already labeled for
 * display, and marked when another entry in the same list satisfies the same
 * requirement (GraphicsMagick vs ImageMagick) — the wire carries that
 * choose-one fact so no renderer has to decode it from an id.
 */
const MissingToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  interchangeable: z.boolean(),
  /** What TeXRA can't do without it, completing "TeXRA can't …". */
  usedFor: z.string(),
});
export type MissingTool = z.infer<typeof MissingToolSchema>;

export const DependencyBannerDataSchema = z.object({
  missingTools: z.array(MissingToolSchema).nullish(),
});

// ============================================================
// File State Schemas
// ============================================================

const FileSelectConfigSchema = z.object({
  type: DocumentFileTypeSchema,
  label: z.string(),
  icon: z.enum(TEXRA_ICON_CANONICAL_NAMES),
  addOpenedLabel: z.string(),
  emptyListLabel: z.string(),
  selectListLabel: z.string(),
  toolConfig: z.enum(['tool', 'autoExtract']).nullish(),
});
export type FileSelectConfig = z.infer<typeof FileSelectConfigSchema>;

export type CheckboxValues = z.infer<typeof ToolConfigFieldsSchema>;

export const FileOptionsSchema = z.object({
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

export const GettingStartedActionSchema = z.enum([
  'runSetup',
  'createSampleProject',
  'cloneOverleaf',
  'downloadArxiv',
  'openWalkthrough',
]);
export type GettingStartedAction = z.infer<typeof GettingStartedActionSchema>;

/**
 * Single source of truth for the getting-started action command IDs, shared
 * by the Main view banner and the Progress view empty-state list so the two
 * surfaces can't drift out of sync.
 */
export const GETTING_STARTED_COMMANDS = {
  runSetup: 'texra.runSetupAssistant',
  createSampleProject: 'texra.createSampleProject',
  cloneOverleaf: 'texra.cloneOverleafProject',
  downloadArxiv: 'texra.downloadArXivSource',
  openWalkthrough: 'texra.openGettingStarted',
} satisfies Record<GettingStartedAction, string>;

/**
 * Button label and leading icon for each getting-started action — the
 * presentation counterpart to {@link GETTING_STARTED_COMMANDS}. The Main view
 * getting-started banner, the Progress view empty state, and the onboarding
 * cards all render the same actions, so the words and glyph live here rather
 * than being re-typed per surface.
 */
export const GETTING_STARTED_ACTION_PRESENTATION = {
  runSetup: { label: 'Run setup assistant', icon: 'rocket' },
  createSampleProject: {
    label: 'Create sample project',
    icon: 'file-circle-plus',
  },
  cloneOverleaf: { label: 'Import Overleaf', icon: 'cloud-arrow-down' },
  downloadArxiv: { label: 'Import arXiv', icon: 'download' },
  openWalkthrough: { label: 'Open walkthrough', icon: 'book' },
} as const satisfies Record<
  GettingStartedAction,
  { readonly label: string; readonly icon: TeXRAIconName }
>;
