/**
 * MainView schemas - state, messages, and events.
 *
 * Outbound: Backend -> Frontend (SET_*, file selection responses, banners)
 * Inbound: Frontend -> Backend (SELECT_*, REQUEST_*, EXECUTE, etc.)
 */
import { z } from 'zod';

import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { UIFileFieldsSchema } from './fileFields';
import {
  commandOnly,
  withFilesArray,
  withNotifyWhenEmpty,
  withOptionalFilePath,
} from './messageFactories';
import { ToolConfigFieldsSchema } from './toolConfig';

// ============================================================
// Session and File Type Schemas
// ============================================================

export const SessionTypeSchema = z.enum(['toolUse', 'workflow']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

export const DocumentFileTypeSchema = z.enum(['input', 'context', 'media']);
export type DocumentFileType = z.infer<typeof DocumentFileTypeSchema>;

export const MultipleDocumentFileTypeSchema = z.enum([
  'input',
  'context',
  'media',
  'output',
]);
export type MultipleDocumentFileType = z.infer<
  typeof MultipleDocumentFileTypeSchema
>;
export const MULTIPLE_DOCUMENT_FILE_TYPES =
  MultipleDocumentFileTypeSchema.options;

export const ExtendedDocumentFileTypeSchema = z.enum([
  'input',
  'context',
  'media',
  'edited',
  'output',
]);
export type ExtendedDocumentFileType = z.infer<
  typeof ExtendedDocumentFileTypeSchema
>;

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
export const PickerOptionBaseSchema = z.object({
  value: z.string(),
  label: z.string(),
});
export type PickerOptionBase = z.infer<typeof PickerOptionBaseSchema>;

export const ModelAvailabilityKindSchema = z.enum([
  'included-access',
  'provider-key',
  'openrouter-key',
  'missing-key',
  'not-included',
]);
export type ModelAvailabilityKind = z.infer<typeof ModelAvailabilityKindSchema>;

export const ModelOptionDataSchema = PickerOptionBaseSchema.extend({
  provider: z.string().optional(),
  context: z.string().optional(),
  cost: z.string().optional(),
  hint: z.string().optional(),
  availability: ModelAvailabilityKindSchema.optional(),
  availabilityLabel: z.string().optional(),
  requiresKey: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
export type ModelOptionData = z.infer<typeof ModelOptionDataSchema>;

export const AgentOptionDataSchema = PickerOptionBaseSchema.extend({
  isToolUse: z.boolean().optional(),
  isOrchestrator: z.boolean().optional(),
  isRemote: z.boolean().optional(),
  isCustom: z.boolean().optional(),
  description: z.string().optional(),
});
export type AgentOptionData = z.infer<typeof AgentOptionDataSchema>;

// ============================================================
// Persisted State Schema
// ============================================================

// Composes: UIFileFieldsSchema (file fields) + ToolConfigFieldsSchema (tool options)
const MainViewPersistedStateBaseSchema = UIFileFieldsSchema.merge(
  ToolConfigFieldsSchema,
).extend({
  sessionType: SessionTypeSchema.prefault('toolUse'),
  workflowAgent: z.string().prefault('correct'),
  toolUseAgent: z.string().prefault('orchestrator'),
  model: z.string().prefault('gemini31p'),
  commit: z.string().prefault('HEAD'),
  instruction: z.string().prefault(''),
  workflowInstruction: z.string().prefault(''),
  toolUseInstruction: z.string().prefault(''),
  baseFile: z.string().prefault(''),
  inputFilesVisible: z.boolean().prefault(false),
  contextFilesVisible: z.boolean().prefault(false),
  mediaFilesVisible: z.boolean().prefault(false),
  outputFilesVisible: z.boolean().prefault(false),
  outputFilesActive: z.boolean().prefault(false),
  latexdiffsVisible: z.boolean().prefault(false),
  openedFiles: z.array(z.string()).nullish(),
});

/**
 * Back-compat preprocess: migrate legacy `referenceFile`/`referenceFiles`/
 * `referenceFilesVisible` and `auxiliaryFile`/`auxiliaryFiles`/
 * `auxiliaryFilesVisible` keys (persisted by older versions before the
 * auxiliary picker was unified into Context) into the canonical
 * `contextFile`/`contextFiles`/`contextFilesVisible` shape. New keys win
 * when both are present.
 */
function migrateLegacyAuxiliaryReferenceState(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const obj = { ...(input as Record<string, unknown>) };

  // Migrate legacy single-file slot.
  if (obj.contextFile === undefined) {
    if (
      obj.referenceFile !== undefined &&
      obj.referenceFile !== null &&
      obj.referenceFile !== ''
    ) {
      obj.contextFile = obj.referenceFile;
    } else if (
      obj.auxiliaryFile !== undefined &&
      obj.auxiliaryFile !== null &&
      obj.auxiliaryFile !== ''
    ) {
      obj.contextFile = obj.auxiliaryFile;
    }
  }

  // Merge legacy multi-file lists: contextFiles wins; otherwise concatenate
  // referenceFiles and auxiliaryFiles. If the auxiliary single slot didn't
  // claim the contextFile spot, also fold it into the multi list to avoid
  // silently dropping the user's selection.
  if (obj.contextFiles === undefined) {
    const refList = Array.isArray(obj.referenceFiles) ? obj.referenceFiles : [];
    const auxList = Array.isArray(obj.auxiliaryFiles) ? obj.auxiliaryFiles : [];
    const auxSingleNeedsFallback =
      typeof obj.auxiliaryFile === 'string' &&
      obj.auxiliaryFile.length > 0 &&
      obj.contextFile !== obj.auxiliaryFile;
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const f of [
      ...refList,
      ...auxList,
      ...(auxSingleNeedsFallback ? [obj.auxiliaryFile as string] : []),
    ]) {
      if (typeof f === 'string' && !seen.has(f)) {
        seen.add(f);
        merged.push(f);
      }
    }
    if (merged.length > 0 || refList.length > 0 || auxList.length > 0) {
      obj.contextFiles = merged;
    }
  }

  if (obj.contextFilesVisible === undefined) {
    if (obj.referenceFilesVisible || obj.auxiliaryFilesVisible) {
      obj.contextFilesVisible = true;
    }
  }

  // Drop legacy keys so they don't sneak through unknown-key handling.
  delete obj.referenceFile;
  delete obj.referenceFiles;
  delete obj.referenceFilesVisible;
  delete obj.auxiliaryFile;
  delete obj.auxiliaryFiles;
  delete obj.auxiliaryFilesVisible;

  return obj;
}

export const MainViewPersistedStateSchema = z.preprocess(
  migrateLegacyAuxiliaryReferenceState,
  MainViewPersistedStateBaseSchema,
);
export type MainViewPersistedState = z.infer<
  typeof MainViewPersistedStateSchema
>;

// ============================================================
// Banner State Schemas
// ============================================================

export const BannerStateSchema = z.object({
  visible: z.boolean(),
});
export type BannerState = z.infer<typeof BannerStateSchema>;

export const ApiKeyBannerStateSchema = BannerStateSchema.extend({
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});
export type ApiKeyBannerState = z.infer<typeof ApiKeyBannerStateSchema>;

export const AgentConfigBannerStateSchema = BannerStateSchema.extend({
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});
export type AgentConfigBannerState = z.infer<
  typeof AgentConfigBannerStateSchema
>;

export const DependencyBannerStateSchema = BannerStateSchema.extend({
  missingTools: z.array(z.string()).nullish(),
});
export type DependencyBannerState = z.infer<typeof DependencyBannerStateSchema>;

// ============================================================
// File State Schemas
// ============================================================

export const FileSelectConfigSchema = z.object({
  type: DocumentFileTypeSchema,
  label: z.string(),
  icon: z.string(),
  refreshTitle: z.string(),
  currentTitle: z.string(),
  emptyTitle: z.string(),
  toggleTitle: z.string(),
  addOpenedLabel: z.string(),
  emptyListLabel: z.string(),
  selectListLabel: z.string(),
  tooltip: z.string(),
  description: z.string().nullish(),
  toolConfig: z.enum(['tool', 'autoExtract']).nullish(),
  focusInstruction: z
    .object({
      key: z.string(),
      text: z.string(),
    })
    .nullish(),
});
export type FileSelectConfig = z.infer<typeof FileSelectConfigSchema>;

// Bottom-up: Use ToolConfigFieldsSchema directly instead of picking from the composed parent
export const CheckboxValuesSchema = ToolConfigFieldsSchema;
export type CheckboxValues = z.infer<typeof CheckboxValuesSchema>;

export const SingleFilesSchema = z.object({
  inputFile: z.string(),
  contextFile: z.string(),
  mediaFile: z.string(),
  baseFile: z.string(),
  editedFile: z.string(),
});
export type SingleFiles = z.infer<typeof SingleFilesSchema>;

export const FileOptionsSchema = z.object({
  inputFile: z.array(z.string()),
  contextFile: z.array(z.string()),
  mediaFile: z.array(z.string()),
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()).optional(),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

export const MultiFilesSchema = z.object({
  inputFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  mediaFiles: z.array(z.string()),
  outputFiles: z.array(z.string()),
});
export type MultiFiles = z.infer<typeof MultiFilesSchema>;

export const MultiFilesVisibleSchema = z.object({
  inputFiles: z.boolean(),
  contextFiles: z.boolean(),
  mediaFiles: z.boolean(),
  outputFiles: z.boolean(),
});
export type MultiFilesVisible = z.infer<typeof MultiFilesVisibleSchema>;

export const FileStateContextSchema = z.object({
  sessionType: SessionTypeSchema,
  checkboxValues: CheckboxValuesSchema,
  singleFiles: SingleFilesSchema,
  fileOptions: FileOptionsSchema,
  multiFiles: MultiFilesSchema,
  multiFilesVisible: MultiFilesVisibleSchema,
  outputFilesActive: z.boolean(),
});
export type FileStateContextValue = z.infer<typeof FileStateContextSchema>;

export const SessionContextSchema = z.object({
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
});
export type SessionContextValue = z.infer<typeof SessionContextSchema>;

// ============================================================
// Event Detail Schemas (frontend custom events)
// ============================================================

export const FileSelectChangeDetailSchema = z.object({
  type: DocumentFileTypeSchema,
  value: z.string(),
});
export type FileSelectChangeDetail = z.infer<
  typeof FileSelectChangeDetailSchema
>;

export const StringValueDetailSchema = z.object({
  value: z.string(),
});
export type StringValueDetail = z.infer<typeof StringValueDetailSchema>;

export type BaseFileChangeDetail = StringValueDetail;
export type EditedFileChangeDetail = StringValueDetail;
export type ModelChangeDetail = StringValueDetail;
export type InstructionChangeDetail = StringValueDetail;
export type CommitChangeDetail = StringValueDetail;

export const FileActionDetailSchema = z.object({
  type: z.union([DocumentFileTypeSchema, z.enum(['base', 'edited'])]),
});
export type FileActionDetail = z.infer<typeof FileActionDetailSchema>;

export const MultipleFilesActionDetailSchema = z.object({
  listId: z.string(),
});
export type MultipleFilesActionDetail = z.infer<
  typeof MultipleFilesActionDetailSchema
>;

export const MultipleFilesTypeActionDetailSchema = z.object({
  type: MultipleDocumentFileTypeSchema,
});
export type MultipleFilesTypeActionDetail = z.infer<
  typeof MultipleFilesTypeActionDetailSchema
>;

export const RemoveFileDetailSchema = z.object({
  listId: z.string(),
  file: z.string(),
});
export type RemoveFileDetail = z.infer<typeof RemoveFileDetailSchema>;

export const ReorderFilesDetailSchema = z.object({
  listId: z.string(),
  files: z.array(z.string()),
});
export type ReorderFilesDetail = z.infer<typeof ReorderFilesDetailSchema>;

export const CheckboxChangeDetailSchema = z.object({
  id: z.string(),
  checked: z.boolean(),
});
export type CheckboxChangeDetail = z.infer<typeof CheckboxChangeDetailSchema>;

export const BannerActionDetailSchema = z.object({
  action: z.string(),
  provider: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});
export type BannerActionDetail = z.infer<typeof BannerActionDetailSchema>;

export const InstallGuideDetailSchema = z.object({
  tool: z.string(),
});
export type InstallGuideDetail = z.infer<typeof InstallGuideDetailSchema>;

export const LatexDiffsToggleDetailSchema = z.object({
  visible: z.boolean(),
});
export type LatexDiffsToggleDetail = z.infer<
  typeof LatexDiffsToggleDetailSchema
>;

export const LatexDiffsActionDetailSchema = z.object({
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

export const FocusInstructionDetailSchema = z.object({
  key: z.string(),
  text: z.string(),
});
export type FocusInstructionDetail = z.infer<
  typeof FocusInstructionDetailSchema
>;

export const SessionTypeChangeDetailSchema = z.object({
  value: SessionTypeSchema,
});
export type SessionTypeChangeDetail = z.infer<
  typeof SessionTypeChangeDetailSchema
>;

export const AgentChangeDetailSchema = z.object({
  sessionType: SessionTypeSchema,
  value: z.string(),
});
export type AgentChangeDetail = z.infer<typeof AgentChangeDetailSchema>;

export const ActionDetailSchema = z.object({
  action: z.string(),
});
export type ActionDetail = z.infer<typeof ActionDetailSchema>;

// ============================================================
// Outbound Message Schemas (backend -> frontend)
// ============================================================

const FileListSchema = z.array(z.string());
const FilesPayloadSchema = z.object({ files: FileListSchema });
const SingleFileSelectedSchema = z.object({ filePath: z.string() });
const BaseFileOptionsSchema = z.object({
  preserveBaseFile: z.boolean().nullish(),
});

export const SetModelOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  optionsData: z.array(ModelOptionDataSchema).optional(),
});

export const SetAgentOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS),
  optionsData: z
    .object({
      workflow: z.array(AgentOptionDataSchema).optional(),
      toolUse: z.array(AgentOptionDataSchema).optional(),
    })
    .optional(),
});

export const SetInputFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_INPUT_FILE),
});

export const SetContextFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CONTEXT_FILE),
});

export const SetMediaFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MEDIA_FILE),
});

export const SetEditedFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_EDITED_FILE),
});

export const SetBaseFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_BASE_FILE),
  preserveBaseFile: BaseFileOptionsSchema.shape.preserveBaseFile,
});

export const InputFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED),
});

export const ContextFileSelectedMessageSchema = SingleFileSelectedSchema.extend(
  {
    command: z.literal(MAIN_VIEW_COMMANDS.CONTEXT_FILE_SELECTED),
  },
);

export const MediaFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED),
});

export const EditedFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED),
});

export const SetInputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
});

export const SetContextFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES),
});

export const SetMediaFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
});

export const SetOutputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES),
});

export const SetDefaultOutputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES),
});

export const AddMediaFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE),
  file: z.string(),
});

export const SetRecentCommitsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS),
  commits: FileListSchema,
  isGitRepo: z.boolean().nullish(),
});

export const SetCurrentFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CURRENT_FILE),
  filePath: z.string(),
  fileType: z.string(),
});

export const SetSelectedCommitMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT),
  commitHash: z.string(),
  commitLabel: z.string().nullish(),
});

export const SetOpenedFilesMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OPENED_FILES),
  files: FileListSchema,
  fileType: z.string(),
  shouldFilter: z.boolean().nullish(),
});

export const SetAllSingleFilesMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES),
  inputFiles: FileListSchema.nullish(),
  contextFiles: FileListSchema.nullish(),
  mediaFiles: FileListSchema.nullish(),
});

export const InstructionTextPolishedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED),
  text: z.string(),
});

export const InstructionTextPolishErrorMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR),
  error: z.string().nullish(),
});

export const InstructionTextTranscribedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED),
  text: z.string().nullish(),
});

export const RecordingStartedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STARTED),
});

export const RecordingStoppedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STOPPED),
});

export const RecordingErrorMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_ERROR),
});

export const ShowApiKeyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});

export const HideApiKeyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER),
});

export const ShowAgentConfigBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});

export const HideAgentConfigBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER),
});

export const ShowDependencyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
  missingTools: z.array(z.string()).nullish(),
});

export const HideDependencyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER),
});

export const ShowGettingStartedBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER),
});

export const HideGettingStartedBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER),
});

export const ShowOrchestratorBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER),
});

export const HideOrchestratorBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER),
});

export const ShowLoginBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER),
});

export const HideLoginBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER),
});

export const SetSelectedAgentMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT),
  agentId: z.string().nullish(),
  sessionType: z.string().nullish(),
});

export const RequestRecentCommitsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS),
  notifyWhenEmpty: z.boolean().nullish(),
});

export const LatexdiffMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.LATEXDIFF),
  inputFile: z.string(),
  baseFile: z.string(),
  editedFile: z.string(),
});

export const LatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.LATEXDIFFVC),
  inputFile: z.string(),
  baseFile: z.string(),
  commitHash: z.string(),
});

const latexdiffvcOperationFields = {
  inputFile: z.string(),
  baseFile: z.string(),
  commitHash: z.string(),
  clean: z.boolean().nullish(),
};

const PackLatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC),
  ...latexdiffvcOperationFields,
});

const CleanLatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC),
  ...latexdiffvcOperationFields,
});

export const LatexdiffvcOperationMessageSchema = z.discriminatedUnion(
  'command',
  [PackLatexdiffvcMessageSchema, CleanLatexdiffvcMessageSchema],
);

export const MainViewMessageSchema = z.discriminatedUnion('command', [
  SetModelOptionsMessageSchema,
  SetAgentOptionsMessageSchema,
  SetInputFileMessageSchema,
  SetContextFileMessageSchema,
  SetMediaFileMessageSchema,
  SetEditedFileMessageSchema,
  SetBaseFileMessageSchema,
  InputFileSelectedMessageSchema,
  ContextFileSelectedMessageSchema,
  MediaFileSelectedMessageSchema,
  EditedFileSelectedMessageSchema,
  SetInputFilesMessageSchema,
  SetContextFilesMessageSchema,
  SetMediaFilesMessageSchema,
  SetOutputFilesMessageSchema,
  SetDefaultOutputFilesMessageSchema,
  AddMediaFileMessageSchema,
  SetRecentCommitsMessageSchema,
  SetCurrentFileMessageSchema,
  SetSelectedCommitMessageSchema,
  SetOpenedFilesMessageSchema,
  SetAllSingleFilesMessageSchema,
  InstructionTextPolishedMessageSchema,
  InstructionTextPolishErrorMessageSchema,
  InstructionTextTranscribedMessageSchema,
  RecordingStartedMessageSchema,
  RecordingStoppedMessageSchema,
  RecordingErrorMessageSchema,
  ShowApiKeyBannerMessageSchema,
  HideApiKeyBannerMessageSchema,
  ShowAgentConfigBannerMessageSchema,
  HideAgentConfigBannerMessageSchema,
  ShowDependencyBannerMessageSchema,
  HideDependencyBannerMessageSchema,
  ShowGettingStartedBannerMessageSchema,
  HideGettingStartedBannerMessageSchema,
  ShowOrchestratorBannerMessageSchema,
  HideOrchestratorBannerMessageSchema,
  ShowLoginBannerMessageSchema,
  HideLoginBannerMessageSchema,
  SetSelectedAgentMessageSchema,
]);

export type MainViewMessage = z.infer<typeof MainViewMessageSchema>;
export type RequestRecentCommitsMessage = z.infer<
  typeof RequestRecentCommitsMessageSchema
>;
export type LatexdiffMessage = z.infer<typeof LatexdiffMessageSchema>;
export type LatexdiffvcMessage = z.infer<typeof LatexdiffvcMessageSchema>;
export type LatexdiffvcOperationMessage = z.infer<
  typeof LatexdiffvcOperationMessageSchema
>;

// ============================================================
// Inbound Message Schemas (frontend -> backend)
// ============================================================

// Factory functions imported from ./messageFactories

const CommonMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.WEBVIEW_READY),
  commandOnly(MAIN_VIEW_COMMANDS.GET_THEME),
  commandOnly(MAIN_VIEW_COMMANDS.GET_DEBUG_MODE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SWITCH_VIEW),
    view: z.enum(['main', 'progress', 'dashboard']),
    openInEditor: z.boolean().nullish(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.THEME_SET),
    theme: z.enum(['dark', 'light']),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.DEBUG_MODE_SET),
    debugMode: z.boolean(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
    text: z.string().min(1),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION),
    key: z.string().min(1),
    text: z.string().min(1),
  }),
] as const;

export const OpenAgentSettingsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS),
  sessionType: SessionTypeSchema.optional(),
});

export const OpenAgentDirectoryMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY),
  customDirSet: z.boolean().optional(),
});

const SettingsMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SETTINGS_OPEN),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS),
  OpenAgentSettingsMessageSchema,
  OpenAgentDirectoryMessageSchema,
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.MODEL_SELECTED),
    model: z.string().min(1),
  }),
] as const;

const ExecutionMessages = [
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.EXECUTE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.MERGE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.COMPARE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.ACCEPT_EDITED) }),
] as const;

const FileSelectionMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_CONTEXT_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES),
    fileType: ExtendedDocumentFileTypeSchema,
    currentFile: z.string().optional(),
  }),
] as const;

const FileSelectedMessages = [
  withOptionalFilePath(MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.CONTEXT_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED),
] as const;

const RequestFileMessages = [
  withNotifyWhenEmpty(MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE),
  withNotifyWhenEmpty(MAIN_VIEW_COMMANDS.REQUEST_CONTEXT_FILE),
  withNotifyWhenEmpty(MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE),
    notifyWhenEmpty: z.boolean().nullish(),
    baseFile: z.string().optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE),
    notifyWhenEmpty: z.boolean().nullish(),
    preserveBaseFile: z.boolean().optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES),
    agent: z.string().optional(),
  }),
] as const;

const SetFilesMessages = [
  withFilesArray(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
] as const;

const FileOperationMessages = [
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE),
    fileType: z.string().optional(),
    baseFile: z.string().optional(),
  }),
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES),
    fileType: ExtendedDocumentFileTypeSchema,
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES),
    paths: z.array(z.string()),
    target: MultipleDocumentFileTypeSchema.nullish(),
  }),
  // Note: Use withFilesArray (required files) directly instead of
  // withOptionalFiles + .extend() override pattern
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES).extend({
    fileType: z.literal('input'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_CONTEXT_FILES).extend({
    fileType: z.literal('context'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES).extend({
    fileType: z.literal('media'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES).extend({
    fileType: z.literal('output'),
  }),
] as const;

const InstructionMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT),
    text: z.string(),
    agent: z.string().optional(),
    model: z.string().optional(),
    inputFile: z.string().optional(),
    inputFiles: z.array(z.string()).optional(),
    contextFile: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    mediaFile: z.string().optional(),
    mediaFiles: z.array(z.string()).optional(),
    outputFiles: z.array(z.string()).optional(),
    inputFilesActive: z.boolean().optional(),
    contextFilesActive: z.boolean().optional(),
    mediaFilesActive: z.boolean().optional(),
    outputFilesActive: z.boolean().optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE),
    base64: z.string(),
    mediaType: z.string(),
    fileName: z.string(),
  }),
] as const;

const RecordingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.START_RECORDING),
  commandOnly(MAIN_VIEW_COMMANDS.STOP_RECORDING),
] as const;

const ApiKeyMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY),
    provider: z.string().min(1).optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL),
    provider: z.string().min(1).optional(),
  }),
] as const;

const BannerMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.DISMISS_GETTING_STARTED_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
    missingTools: z.array(z.string()).optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE),
    tool: z.string().min(1),
  }),
] as const;

const GitDiffMessages = [
  RequestRecentCommitsMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_COMMITS),
  LatexdiffMessageSchema,
  LatexdiffvcMessageSchema,
  PackLatexdiffvcMessageSchema,
  CleanLatexdiffvcMessageSchema,
] as const;

const singleOperationFields = {
  inputFile: z.string(),
  agent: z.string(),
  model: z.string(),
};

const PackSingleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_SINGLE),
  ...singleOperationFields,
});

const CleanSingleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_SINGLE),
  ...singleOperationFields,
});

const PackMultipleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_MULTIPLE),
  ...singleOperationFields,
  outputFiles: z.array(z.string()).optional(),
});

const CleanMultipleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE),
  ...singleOperationFields,
  outputFiles: z.array(z.string()).optional(),
});

const HousekeepingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_OUTPUT),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_BUILD),
  commandOnly(MAIN_VIEW_COMMANDS.INDENT_TEX),
  PackSingleMessageSchema,
  CleanSingleMessageSchema,
  PackMultipleMessageSchema,
  CleanMultipleMessageSchema,
] as const;

const NavigationMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY),
] as const;

export const MainViewInboundMessageSchema = z.discriminatedUnion('command', [
  ...CommonMessages,
  ...SettingsMessages,
  ...ExecutionMessages,
  ...FileSelectionMessages,
  ...FileSelectedMessages,
  ...RequestFileMessages,
  ...SetFilesMessages,
  ...FileOperationMessages,
  ...InstructionMessages,
  ...RecordingMessages,
  ...ApiKeyMessages,
  ...BannerMessages,
  ...GitDiffMessages,
  ...HousekeepingMessages,
  ...NavigationMessages,
]);

export type MainViewInboundMessage = z.infer<
  typeof MainViewInboundMessageSchema
>;

// ============================================================
// Handler Registry and Dispatcher
// ============================================================

export type MainViewInboundHandlerRegistry =
  HandlerRegistry<MainViewInboundMessage>;

export const dispatchMainViewInbound = createDispatcher(
  MainViewInboundMessageSchema,
);
