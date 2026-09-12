/**
 * MainView state and data schemas (option rows, banners,
 * file state, and event detail shapes). Kept free of any IPC message wrappers
 * so the message modules can compose these without circular dependencies.
 */
import { z } from 'zod';

import { CHATGPT_AUTH, GROK_AUTH } from '@shared/copy/accountAuth';
import { AgentCategorySchema, AgentSourceSchema } from '@shared/schemas/agent';
import {
  TEXRA_ICON_CANONICAL_NAMES,
  type TeXRAIconName,
} from '@shared/wa/iconNames';
import { requiredFileListFields } from '../fileFields';
import {
  CurrentFileTypeSchema,
  DocumentFileTypeSchema,
  MultipleDocumentFileTypeSchema,
} from '../fileTypes';
import { ToolConfigFieldsSchema } from '../toolConfig';

// ============================================================
// Session Schemas
// ============================================================

/**
 * The main view's surface name for the {@link AgentCategory} a session runs
 * as. The value set is identical by construction (`'toolUse' | 'workflow'`),
 * so the schema is derived from the canonical one rather than redeclared —
 * the two vocabularies cannot drift. Persisted and wire values are
 * byte-identical to the historical standalone enum.
 */
export const SessionTypeSchema = AgentCategorySchema;
export type SessionType = z.infer<typeof SessionTypeSchema>;

/** Who runs a main-view request: a single agent or a multi-agent team. */
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
  // Permission state is reported by the VS Code host.
  'copilot-access',
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
  'copilot-access': {
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
  // Only the OpenRouter route produces this kind (`computeModelOptions`
  // resolves it from `isOpenRouterRoutingUnsupported`), so the one label the
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
 * Resolved per-model access. Computed once by `computeModelOptionsData` and
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
 * Whether an option row can be run as shipped: `computeModelOptionsData`
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
  isToolUse: z.boolean().optional(),
  isOrchestrator: z.boolean().optional(),
  /** Provenance, in the canonical agent vocabulary rather than one-hot flags. */
  source: AgentSourceSchema.optional(),
});
export type AgentOptionData = z.infer<typeof AgentOptionDataSchema>;

/** Open workspace folder offered as a run working directory. */
export const WorkspaceRootOptionDataSchema = PickerOptionBaseSchema;
type WorkspaceRootOptionData = z.infer<typeof WorkspaceRootOptionDataSchema>;

/**
 * Team picker option row for the main-view "Run with: Team" target. `value`
 * carries the preset id (one of the built-ins in `AGENT_MODE_PRESETS` or a
 * user-saved custom team); hosts resolve the roster, so the renderer only
 * ever sends team identity back. Availability is resolved against the full
 * live catalog, not just the workspace's enabled roster.
 */
export const TeamOptionDataSchema = PickerOptionBaseSchema.extend({
  /** Provenance uses the shared `'built-in' | 'custom'` team vocabulary. */
  source: z.enum(['built-in', 'custom']),
  /** Web Awesome icon name registered in `src/shared/wa/iconNames.ts`. */
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
// Banner State Schemas
// ============================================================

const BannerStateSchema = z.object({
  visible: z.boolean(),
});
export type BannerState = z.infer<typeof BannerStateSchema>;

export const ApiKeyBannerDataSchema = z.object({
  provider: z.string().nullish(),
});
const ApiKeyBannerStateSchema = BannerStateSchema.extend(
  ApiKeyBannerDataSchema.shape,
);
export type ApiKeyBannerState = z.infer<typeof ApiKeyBannerStateSchema>;

export const AgentConfigBannerDataSchema = z.object({
  agentName: z.string().nullish(),
  /** The category the named agent was launched as: what the banner's
   *  actions edit, whichever surface renders the strip. */
  sessionType: SessionTypeSchema.nullish(),
  customDirSet: z.boolean().nullish(),
});
const AgentConfigBannerStateSchema = BannerStateSchema.extend(
  AgentConfigBannerDataSchema.shape,
);
export type AgentConfigBannerState = z.infer<
  typeof AgentConfigBannerStateSchema
>;

export const DependencyBannerDataSchema = z.object({
  missingTools: z.array(z.string()).nullish(),
});
const DependencyBannerStateSchema = BannerStateSchema.extend(
  DependencyBannerDataSchema.shape,
);
export type DependencyBannerState = z.infer<typeof DependencyBannerStateSchema>;

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

const SingleFilesSchema = z.object({
  baseFile: z.string(),
  editedFile: z.string(),
});
type SingleFiles = z.infer<typeof SingleFilesSchema>;

export const FileOptionsSchema = z.object({
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

// Enumerates the four multi-file keys so listId fields below name a file list.
const MultiFilesKeySchema = z.object(requiredFileListFields).keyof();

const StringValueDetailSchema = z.object({
  value: z.string(),
});
type StringValueDetail = z.infer<typeof StringValueDetailSchema>;

export type BaseFileChangeDetail = StringValueDetail;
export type EditedFileChangeDetail = StringValueDetail;
export type CommitChangeDetail = StringValueDetail;

const FileActionDetailSchema = z.object({
  type: CurrentFileTypeSchema,
});
export type FileActionDetail = z.infer<typeof FileActionDetailSchema>;

const MultipleFilesActionDetailSchema = z.object({
  listId: MultiFilesKeySchema,
});
export type MultipleFilesActionDetail = z.infer<
  typeof MultipleFilesActionDetailSchema
>;

const MultipleFilesTypeActionDetailSchema = z.object({
  type: MultipleDocumentFileTypeSchema,
});
export type MultipleFilesTypeActionDetail = z.infer<
  typeof MultipleFilesTypeActionDetailSchema
>;

const RemoveFileDetailSchema = z.object({
  listId: MultiFilesKeySchema,
  file: z.string(),
});
export type RemoveFileDetail = z.infer<typeof RemoveFileDetailSchema>;

const ReorderFilesDetailSchema = z.object({
  listId: MultiFilesKeySchema,
  files: z.array(z.string()),
});
export type ReorderFilesDetail = z.infer<typeof ReorderFilesDetailSchema>;

const CheckboxChangeDetailSchema = z.object({
  id: z.string(),
  checked: z.boolean(),
});
export type CheckboxChangeDetail = z.infer<typeof CheckboxChangeDetailSchema>;

/**
 * Per-banner action details. Each banner's detail carries its own action
 * literal set plus only the fields that banner fills, so handlers receive a
 * closed union instead of a shared loose `{ action: string }` type that
 * required casts at every dispatch site.
 */
const ApiKeyBannerActionDetailSchema = z.object({
  action: z.enum(['set', 'guide']),
  provider: z.string().nullish(),
});
export type ApiKeyBannerActionDetail = z.infer<
  typeof ApiKeyBannerActionDetailSchema
>;

const AgentConfigBannerActionDetailSchema = z.object({
  action: z.enum(['edit', 'dir', 'docs']),
  customDirSet: z.boolean().nullish(),
});
export type AgentConfigBannerActionDetail = z.infer<
  typeof AgentConfigBannerActionDetailSchema
>;

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

const GettingStartedActionDetailSchema = z.object({
  action: GettingStartedActionSchema,
});
export type GettingStartedActionDetail = z.infer<
  typeof GettingStartedActionDetailSchema
>;

const InstallGuideDetailSchema = z.object({
  tool: z.string(),
});
export type InstallGuideDetail = z.infer<typeof InstallGuideDetailSchema>;

const LatexDiffsActionDetailSchema = z.object({
  action: z.enum([
    'latexdiff',
    'latexdiffvc',
    'packLatexdiffvc',
    'cleanLatexdiffvc',
    'merge',
    'compare',
    'accept',
  ]),
});
export type LatexDiffsActionDetail = z.infer<
  typeof LatexDiffsActionDetailSchema
>;
