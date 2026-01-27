import { z } from 'zod';

import {
  AgentOptionDataSchema,
  ModelOptionDataSchema,
} from './mainViewMessages';

export const SessionTypeSchema = z.enum(['toolUse', 'workflow']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

export const FileTypeSchema = z.enum([
  'input',
  'reference',
  'auxiliary',
  'media',
]);
export type FileType = z.infer<typeof FileTypeSchema>;

export const MultipleFileTypeSchema = z.enum([
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
]);
export type MultipleFileType = z.infer<typeof MultipleFileTypeSchema>;

export const MainViewPersistedStateSchema = z.object({
  sessionType: SessionTypeSchema.prefault('toolUse'),
  workflowAgent: z.string().prefault('correct'),
  toolUseAgent: z.string().prefault('chat'),
  model: z.string().prefault('gemini3p'),
  commit: z.string().prefault('HEAD'),
  instruction: z.string().prefault(''),
  inputFile: z.string().prefault(''),
  referenceFile: z.string().prefault(''),
  auxiliaryFile: z.string().prefault(''),
  mediaFile: z.string().prefault(''),
  editedFile: z.string().prefault(''),
  baseFile: z.string().prefault(''),
  inputFiles: z.array(z.string()).prefault([]),
  referenceFiles: z.array(z.string()).prefault([]),
  auxiliaryFiles: z.array(z.string()).prefault([]),
  mediaFiles: z.array(z.string()).prefault([]),
  outputFiles: z.array(z.string()).prefault([]),
  inputFilesVisible: z.boolean().prefault(false),
  referenceFilesVisible: z.boolean().prefault(false),
  auxiliaryFilesVisible: z.boolean().prefault(false),
  mediaFilesVisible: z.boolean().prefault(false),
  outputFilesVisible: z.boolean().prefault(false),
  outputFilesActive: z.boolean().prefault(false),
  latexdiffsVisible: z.boolean().prefault(false),
  autoExtractFigure: z.boolean().prefault(false),
  autoExtractTikzFigure: z.boolean().prefault(false),
  autoCompileInputPdf: z.boolean().prefault(false),
  attachTeXCount: z.boolean().prefault(false),
  attachDiagnostics: z.boolean().prefault(false),
  agent: z.string().prefault(''),
  isToolUseAgent: z.boolean().prefault(true),
  openedFiles: z.array(z.string()).nullish(),
});

export type MainViewPersistedState = z.infer<
  typeof MainViewPersistedStateSchema
>;

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

export const FileSelectConfigSchema = z.object({
  type: FileTypeSchema,
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
  toolConfig: z.enum(['tool', 'autoExtract']).nullish(),
  focusInstruction: z
    .object({
      key: z.string(),
      text: z.string(),
    })
    .nullish(),
});
export type FileSelectConfig = z.infer<typeof FileSelectConfigSchema>;

export const CheckboxValuesSchema = MainViewPersistedStateSchema.pick({
  autoExtractFigure: true,
  autoExtractTikzFigure: true,
  autoCompileInputPdf: true,
  attachTeXCount: true,
  attachDiagnostics: true,
});
export type CheckboxValues = z.infer<typeof CheckboxValuesSchema>;

export const SingleFilesSchema = z.object({
  inputFile: z.string(),
  referenceFile: z.string(),
  auxiliaryFile: z.string(),
  mediaFile: z.string(),
  baseFile: z.string(),
  editedFile: z.string(),
});
export type SingleFiles = z.infer<typeof SingleFilesSchema>;

export const FileOptionsSchema = z.object({
  inputFile: z.array(z.string()),
  referenceFile: z.array(z.string()),
  auxiliaryFile: z.array(z.string()),
  mediaFile: z.array(z.string()),
  baseFile: z.array(z.string()),
  editedFile: z.array(z.string()),
  commit: z.array(z.string()).optional(),
});
export type FileOptions = z.infer<typeof FileOptionsSchema>;

export const MultiFilesSchema = z.object({
  inputFiles: z.array(z.string()),
  referenceFiles: z.array(z.string()),
  auxiliaryFiles: z.array(z.string()),
  mediaFiles: z.array(z.string()),
  outputFiles: z.array(z.string()),
});
export type MultiFiles = z.infer<typeof MultiFilesSchema>;

export const MultiFilesVisibleSchema = z.object({
  inputFiles: z.boolean(),
  referenceFiles: z.boolean(),
  auxiliaryFiles: z.boolean(),
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
