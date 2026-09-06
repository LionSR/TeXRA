/**
 * The launcher's multi-file groups: the three the New-task state renders,
 * and the `Surface.launch` list each group's `type` selects from. The host
 * publishes `FILE_SELECT_CONFIGS` as `HostSnapshot.fileConfigs` and the
 * components read the list through `LAUNCH_FILE_LISTS`.
 */
import type {
  FileSelectConfig,
  MultipleDocumentFileType,
} from '@shared/schemas';

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
