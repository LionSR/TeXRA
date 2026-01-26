// Third-party imports
import { z } from 'zod';

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

export const CheckboxIdSchema = z.enum([
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoCompileInputPdf',
  'attachTeXCount',
  'attachDiagnostics',
]);
export type CheckboxId = z.infer<typeof CheckboxIdSchema>;

export const CheckboxValuesSchema = z.object({
  autoExtractFigure: z.boolean(),
  autoExtractTikzFigure: z.boolean(),
  autoCompileInputPdf: z.boolean(),
  attachTeXCount: z.boolean(),
  attachDiagnostics: z.boolean(),
});
export type CheckboxValues = z.infer<typeof CheckboxValuesSchema>;

export const ApiKeyBannerStateSchema = z.object({
  visible: z.boolean(),
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});
export type ApiKeyBannerState = z.infer<typeof ApiKeyBannerStateSchema>;

export const AgentConfigBannerStateSchema = z.object({
  visible: z.boolean(),
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});
export type AgentConfigBannerState = z.infer<
  typeof AgentConfigBannerStateSchema
>;

export const DependencyBannerStateSchema = z.object({
  visible: z.boolean(),
  missingTools: z.array(z.string()).nullish(),
});
export type DependencyBannerState = z.infer<typeof DependencyBannerStateSchema>;

export const FocusInstructionSchema = z.object({
  key: z.string(),
  text: z.string(),
});
export type FocusInstruction = z.infer<typeof FocusInstructionSchema>;

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
  focusInstruction: FocusInstructionSchema.nullish(),
});
export type FileSelectConfig = z.infer<typeof FileSelectConfigSchema>;

const stringArrayField = () => z.array(z.string()).prefault([]);

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
  inputFiles: stringArrayField(),
  referenceFiles: stringArrayField(),
  auxiliaryFiles: stringArrayField(),
  mediaFiles: stringArrayField(),
  outputFiles: stringArrayField(),
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
  openedFiles: stringArrayField(),
});

export type MainViewPersistedState = z.infer<
  typeof MainViewPersistedStateSchema
>;
