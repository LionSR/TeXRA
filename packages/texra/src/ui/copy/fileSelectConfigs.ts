/**
 * The launcher's multi-file groups: the three the New-task state renders,
 * and the `Surface.launch` list each group's `type` selects from. The groups
 * are a compile-time constant the renderer reads directly; the list each one
 * selects from comes from `LAUNCH_FILE_LISTS`.
 */
import { Schema } from 'effect';

import {
  DocumentFileTypeSchema,
  type MultipleDocumentFileType,
} from '@texra/shared/launcher/fileTypes';
import { ICON_NAMES } from '@ui/wa/iconNames';

const FileSelectConfigSchema = Schema.Struct({
  type: DocumentFileTypeSchema,
  label: Schema.String,
  icon: Schema.Enum(ICON_NAMES),
  addOpenedLabel: Schema.String,
  emptyListLabel: Schema.String,
  selectListLabel: Schema.String,
  toolConfig: Schema.optional(
    Schema.NullOr(Schema.Literals(['tool', 'autoExtract'])),
  ),
});
export type FileSelectConfig = typeof FileSelectConfigSchema.Type;

export const FILE_SELECT_CONFIGS: ReadonlyArray<FileSelectConfig> = [
  {
    type: 'input',
    label: 'Input',
    icon: 'file-code',
    addOpenedLabel: 'Add opened files as input',
    emptyListLabel: 'Clear all input files',
    selectListLabel: 'Add input files',
    toolConfig: 'tool',
  },
  {
    type: 'context',
    label: 'Context',
    icon: 'book',
    addOpenedLabel: 'Add opened files as context',
    emptyListLabel: 'Clear all context files',
    selectListLabel: 'Add context files',
  },
  {
    type: 'media',
    label: 'Media',
    icon: 'video',
    addOpenedLabel: 'Add opened files as media',
    emptyListLabel: 'Clear all media files',
    selectListLabel: 'Add media files',
    toolConfig: 'autoExtract',
  },
];

/** The `Surface.launch` field a file group's `type` names. */
export const LAUNCH_FILE_LISTS = {
  input: 'inputFiles',
  context: 'contextFiles',
  media: 'mediaFiles',
  output: 'outputFiles',
} as const satisfies Record<MultipleDocumentFileType, string>;
