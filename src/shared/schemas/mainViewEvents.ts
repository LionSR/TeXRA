import { z } from 'zod';

import {
  FileTypeSchema,
  MultipleFileTypeSchema,
  SessionTypeSchema,
} from './mainViewState';

export const FileSelectChangeDetailSchema = z.object({
  type: FileTypeSchema,
  value: z.string(),
});
export type FileSelectChangeDetail = z.infer<
  typeof FileSelectChangeDetailSchema
>;

export const StringValueDetailSchema = z.object({
  value: z.string(),
});
export type StringValueDetail = z.infer<typeof StringValueDetailSchema>;

/** Alias types for semantic clarity - all share the same { value: string } structure */
export type BaseFileChangeDetail = StringValueDetail;
export type EditedFileChangeDetail = StringValueDetail;

export const FileActionDetailSchema = z.object({
  type: z.union([FileTypeSchema, z.enum(['base', 'edited'])]),
});
export type FileActionDetail = z.infer<typeof FileActionDetailSchema>;

export const MultipleFilesActionDetailSchema = z.object({
  listId: z.string(),
});
export type MultipleFilesActionDetail = z.infer<
  typeof MultipleFilesActionDetailSchema
>;

export const MultipleFilesTypeActionDetailSchema = z.object({
  type: MultipleFileTypeSchema,
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

export type CommitChangeDetail = StringValueDetail;

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

export type ModelChangeDetail = StringValueDetail;
export type InstructionChangeDetail = StringValueDetail;

export const ActionDetailSchema = z.object({
  action: z.string(),
});
export type ActionDetail = z.infer<typeof ActionDetailSchema>;
