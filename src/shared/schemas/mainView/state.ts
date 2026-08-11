/**
 * MainView state and data schemas (option rows, persisted state, banners,
 * file state, and event detail shapes). Kept free of any IPC message wrappers
 * so the message modules can compose these without circular dependencies.
 */
import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { AgentCategorySchema } from '@shared/schemas/agent';
import { TEXRA_ICON_CANONICAL_NAMES } from '@shared/wa/iconNames';
import { UIFileFieldsSchema, requiredFileListFields } from '../fileFields';
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
export type LaunchTarget = z.infer<typeof LaunchTargetSchema>;

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
  'included-access',
  'provider-key',
  'openrouter-key',
  'missing-key',
  'not-included',
  'included-login-required',
  'relay-quota-exhausted',
  'retired',
  // ChatGPT-subscription (Codex) access via the user's own OAuth session. Kept
  // distinct from relay `included-access` because it is the user's own
  // credential and runs regardless of relay-vs-personal API mode.
  'subscription-access',
  // Editor-hosted Copilot access is keyless but distinct from ChatGPT and the
  // TeXRA relay. Permission state is reported by the VS Code host.
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
 * Resolved per-model access under the active API mode. Computed once by
 * `computeModelOptionsData` and shared verbatim across hosts (CLI picker,
 * extension Models tab) so availability and routing are never re-derived at
 * render time.
 */
export const ModelAvailabilityFieldsSchema = z.object({
  availability: ModelAvailabilityKindSchema.optional(),
  availabilityLabel: z.string().optional(),
  /** Effective request route for a model that can use multiple backends. */
  routeLabel: z.string().optional(),
  requiresKey: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export const ModelOptionDataSchema = PickerOptionBaseSchema.extend({
  provider: z.string().optional(),
  context: z.string().optional(),
  cost: z.string().optional(),
  hint: z.string().optional(),
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
  return model.disabled !== true && model.requiresKey !== true;
}

export const AgentOptionDataSchema = PickerOptionBaseSchema.extend({
  isToolUse: z.boolean().optional(),
  isOrchestrator: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  isCustom: z.boolean().optional(),
  isInline: z.boolean().optional(),
});
export type AgentOptionData = z.infer<typeof AgentOptionDataSchema>;

/** Open workspace folder offered as an execution working directory. */
export const WorkspaceRootOptionDataSchema = PickerOptionBaseSchema;
export type WorkspaceRootOptionData = z.infer<
  typeof WorkspaceRootOptionDataSchema
>;

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
  /** Resolved delegation-capable team lead; null when none. */
  rootAgentName: z.string().nullish(),
  /** Marks "no runnable team lead"; `disabledReason` carries the human explanation. */
  disabled: z.boolean().optional(),
  disabledReason: z.string().nullish(),
});
export type TeamOptionData = z.infer<typeof TeamOptionDataSchema>;

// ============================================================
// Persisted State Schema
// ============================================================

const WorkflowToolConfigFieldsSchema = ToolConfigFieldsSchema.omit({
  attachDiagnostics: true,
});

/**
 * Legacy persisted blobs carried the per-category agent and instruction as
 * flat `workflowAgent`/`toolUseAgent` and `workflowInstruction`/
 * `toolUseInstruction` fields. Lift them into the canonical `agent`/
 * `instruction` records once, at the parse entrance, when the record keys are
 * absent — otherwise upgrading silently resets the user's saved selections.
 *
 * Introduced 2026-08-04 (#9705); retire three months after ship (target
 * 2026-11-04). The persisted state rewrites in the canonical shape on every
 * main-view save, so the window only covers dormant workspaces.
 */
function liftLegacyMainViewFlatFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const raw = input as Record<string, unknown>;
  const lifted = { ...raw };
  if (raw.agent === undefined) {
    const record = {
      ...(typeof raw.workflowAgent === 'string'
        ? { workflow: raw.workflowAgent }
        : {}),
      ...(typeof raw.toolUseAgent === 'string'
        ? { toolUse: raw.toolUseAgent }
        : {}),
    };
    if (Object.keys(record).length > 0) lifted.agent = record;
  }
  if (raw.instruction === undefined) {
    const record = {
      ...(typeof raw.workflowInstruction === 'string'
        ? { workflow: raw.workflowInstruction }
        : {}),
      ...(typeof raw.toolUseInstruction === 'string'
        ? { toolUse: raw.toolUseInstruction }
        : {}),
    };
    if (Object.keys(record).length > 0) lifted.instruction = record;
  }
  return lifted;
}

// Composes: UIFileFieldsSchema (file fields) + workflow tool options.
export const MainViewPersistedStateSchema = z.preprocess(
  liftLegacyMainViewFlatFields,
  UIFileFieldsSchema.merge(WorkflowToolConfigFieldsSchema).extend({
    sessionType: SessionTypeSchema.prefault('toolUse'),
    launchTarget: LaunchTargetSchema.prefault('agent'),
    selectedTeamId: z.string().prefault(''),
    workingDirectory: z.string().prefault(''),
    agent: z
      .object({
        workflow: z.string().prefault('correct'),
        toolUse: z.string().prefault('orchestrator'),
      })
      .prefault({}),
    model: z.string().prefault(DEFAULT_AGENT_MODEL),
    commit: z.string().prefault('HEAD'),
    instruction: z
      .object({
        workflow: z.string().prefault(''),
        toolUse: z.string().prefault(''),
      })
      .prefault({}),
    baseFile: z.string().prefault(''),
    latexdiffsVisible: z.boolean().prefault(false),
    openedFiles: z.array(z.string()).nullish(),
  }),
);
export type MainViewPersistedState = z.infer<
  typeof MainViewPersistedStateSchema
>;

// ============================================================
// Banner State Schemas
// ============================================================

const BannerStateSchema = z.object({
  visible: z.boolean(),
});
export type BannerState = z.infer<typeof BannerStateSchema>;

const ApiKeyBannerStateSchema = BannerStateSchema.extend({
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});
export type ApiKeyBannerState = z.infer<typeof ApiKeyBannerStateSchema>;

const AgentConfigBannerStateSchema = BannerStateSchema.extend({
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});
export type AgentConfigBannerState = z.infer<
  typeof AgentConfigBannerStateSchema
>;

const DependencyBannerStateSchema = BannerStateSchema.extend({
  missingTools: z.array(z.string()).nullish(),
});
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

export type CheckboxValues = z.infer<typeof WorkflowToolConfigFieldsSchema>;

const SingleFilesSchema = z.object({
  baseFile: z.string(),
  editedFile: z.string(),
});
export type SingleFiles = z.infer<typeof SingleFilesSchema>;

const FileOptionsSchema = z.object({
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()).optional(),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

const MultiFilesSchema = z.object(requiredFileListFields);
export type MultiFiles = z.infer<typeof MultiFilesSchema>;

// Enumerates the four `MultiFiles` keys (`inputFiles` / `contextFiles` /
// `mediaFiles` / `outputFiles`) so `listId` fields below are constrained to
// valid `keyof MultiFiles` values instead of an unconstrained `z.string()`.
const MultiFilesKeySchema = MultiFilesSchema.keyof();

const FileStateContextSchema = z.object({
  sessionType: SessionTypeSchema,
  checkboxValues: WorkflowToolConfigFieldsSchema,
  singleFiles: SingleFilesSchema,
  fileOptions: FileOptionsSchema,
  multiFiles: MultiFilesSchema,
});
export type FileStateContextValue = z.infer<typeof FileStateContextSchema>;

const SessionContextSchema = z.object({
  sessionType: SessionTypeSchema,
  launchTarget: LaunchTargetSchema,
  selectedTeamId: z.string(),
  instruction: z.string(),
  placeholder: z.string(),
  agent: z.record(AgentCategorySchema, z.string()),
  model: z.string(),
  agentOptions: z.record(AgentCategorySchema, z.array(AgentOptionDataSchema)),
  modelOptions: z.array(ModelOptionDataSchema),
  teamOptions: z.array(TeamOptionDataSchema),
  workspaceRootOptions: z.array(WorkspaceRootOptionDataSchema),
  workingDirectory: z.string(),
  isRecording: z.boolean(),
  isPolishing: z.boolean(),
  debugMode: z.boolean(),
  isOrchestratorSelected: z.boolean(),
  /** Last status line pushed to the panel's aria-live region. */
  statusAnnouncement: z.string(),
});
export type SessionContextValue = z.infer<typeof SessionContextSchema>;

const StringValueDetailSchema = z.object({
  value: z.string(),
});
type StringValueDetail = z.infer<typeof StringValueDetailSchema>;

export type BaseFileChangeDetail = StringValueDetail;
export type EditedFileChangeDetail = StringValueDetail;
export type ModelChangeDetail = StringValueDetail;
export type InstructionChangeDetail = StringValueDetail;
export type CommitChangeDetail = StringValueDetail;
export type WorkingDirectoryChangeDetail = StringValueDetail;

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

const BannerActionDetailSchema = z.object({
  action: z.string(),
  provider: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});
export type BannerActionDetail = z.infer<typeof BannerActionDetailSchema>;

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

const LatexDiffsToggleDetailSchema = z.object({
  visible: z.boolean(),
});
export type LatexDiffsToggleDetail = z.infer<
  typeof LatexDiffsToggleDetailSchema
>;

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

const FocusInstructionDetailSchema = z.object({
  key: z.string(),
  text: z.string(),
});
export type FocusInstructionDetail = z.infer<
  typeof FocusInstructionDetailSchema
>;

const SessionTypeChangeDetailSchema = z.object({
  value: SessionTypeSchema,
});
export type SessionTypeChangeDetail = z.infer<
  typeof SessionTypeChangeDetailSchema
>;

const AgentChangeDetailSchema = z.object({
  sessionType: SessionTypeSchema,
  value: z.string(),
});
export type AgentChangeDetail = z.infer<typeof AgentChangeDetailSchema>;

const LaunchTargetChangeDetailSchema = z.object({
  value: LaunchTargetSchema,
});
export type LaunchTargetChangeDetail = z.infer<
  typeof LaunchTargetChangeDetailSchema
>;

export type TeamChangeDetail = StringValueDetail;

const ActionDetailSchema = z.object({
  action: z.string(),
});
export type ActionDetail = z.infer<typeof ActionDetailSchema>;
