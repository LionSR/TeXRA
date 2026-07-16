/**
 * MainView state and data schemas (option rows, persisted state, banners,
 * file state, and event detail shapes). Kept free of any IPC message wrappers
 * so the message modules can compose these without circular dependencies.
 */
import { z } from 'zod';

import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import {
  UIFileFieldsSchema,
  migrateLegacyContextFileFields,
  requiredFileListFields,
} from '../fileFields';
import {
  DocumentFileTypeSchema,
  MultipleDocumentFileTypeSchema,
} from '../fileTypes';
import { ToolConfigFieldsSchema } from '../toolConfig';

// ============================================================
// Session Schemas
// ============================================================

export const SessionTypeSchema = z.enum(['toolUse', 'workflow']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

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
]);
export type ModelAvailabilityKind = z.infer<typeof ModelAvailabilityKindSchema>;

/**
 * Resolved per-model availability under the active API mode. Computed once by
 * `computeModelOptionsData` and shared verbatim across hosts (CLI picker,
 * extension Models tab) so availability is never re-derived at render time.
 */
export const ModelAvailabilityFieldsSchema = z.object({
  availability: ModelAvailabilityKindSchema.optional(),
  availabilityLabel: z.string().optional(),
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

export const AgentOptionDataSchema = PickerOptionBaseSchema.extend({
  isToolUse: z.boolean().optional(),
  isOrchestrator: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  isCustom: z.boolean().optional(),
});
export type AgentOptionData = z.infer<typeof AgentOptionDataSchema>;

// ============================================================
// Persisted State Schema
// ============================================================

const WorkflowToolConfigFieldsSchema = ToolConfigFieldsSchema.omit({
  attachDiagnostics: true,
});

// Composes: UIFileFieldsSchema (file fields) + workflow tool options.
const MainViewPersistedStateBaseSchema = UIFileFieldsSchema.merge(
  WorkflowToolConfigFieldsSchema,
).extend({
  sessionType: SessionTypeSchema.prefault('toolUse'),
  workflowAgent: z.string().prefault('correct'),
  toolUseAgent: z.string().prefault('orchestrator'),
  model: z.string().prefault(DEFAULT_AGENT_MODEL),
  commit: z.string().prefault('HEAD'),
  instruction: z.string().prefault(''),
  workflowInstruction: z.string().prefault(''),
  toolUseInstruction: z.string().prefault(''),
  baseFile: z.string().prefault(''),
  outputFilesActive: z.boolean().prefault(false),
  latexdiffsVisible: z.boolean().prefault(false),
  openedFiles: z.array(z.string()).nullish(),
});

export const MainViewPersistedStateSchema = z.preprocess(
  migrateLegacyContextFileFields,
  MainViewPersistedStateBaseSchema,
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
  icon: z.string(),
  addOpenedLabel: z.string(),
  emptyListLabel: z.string(),
  selectListLabel: z.string(),
  tooltip: z.string(),
  description: z.string().nullish(),
  toolConfig: z.enum(['tool', 'autoExtract']).nullish(),
});
export type FileSelectConfig = z.infer<typeof FileSelectConfigSchema>;

const CheckboxValuesSchema = WorkflowToolConfigFieldsSchema;
export type CheckboxValues = z.infer<typeof CheckboxValuesSchema>;

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
  checkboxValues: CheckboxValuesSchema,
  singleFiles: SingleFilesSchema,
  fileOptions: FileOptionsSchema,
  multiFiles: MultiFilesSchema,
  outputFilesActive: z.boolean(),
});
export type FileStateContextValue = z.infer<typeof FileStateContextSchema>;

const SessionContextSchema = z.object({
  sessionType: SessionTypeSchema,
  instruction: z.string(),
  placeholder: z.string(),
  workflowAgent: z.string(),
  toolUseAgent: z.string(),
  model: z.string(),
  workflowAgentOptions: z.array(AgentOptionDataSchema),
  toolUseAgentOptions: z.array(AgentOptionDataSchema),
  modelOptions: z.array(ModelOptionDataSchema),
  isRecording: z.boolean(),
  isPolishing: z.boolean(),
  debugMode: z.boolean(),
  isOrchestratorSelected: z.boolean(),
});
export type SessionContextValue = z.infer<typeof SessionContextSchema>;

const StringValueDetailSchema = z.object({
  value: z.string(),
});
export type StringValueDetail = z.infer<typeof StringValueDetailSchema>;

export type BaseFileChangeDetail = StringValueDetail;
export type EditedFileChangeDetail = StringValueDetail;
export type ModelChangeDetail = StringValueDetail;
export type InstructionChangeDetail = StringValueDetail;
export type CommitChangeDetail = StringValueDetail;

const FileActionDetailSchema = z.object({
  type: z.union([DocumentFileTypeSchema, z.enum(['base', 'edited'])]),
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

const ActionDetailSchema = z.object({
  action: z.string(),
});
export type ActionDetail = z.infer<typeof ActionDetailSchema>;
