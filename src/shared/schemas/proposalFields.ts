import { z } from 'zod';

import { ToolConfigSchema } from './toolConfig';

export const BaseProposalFieldsSchema = z.object({
  agent: z.string(),
  model: z.string(),
  instruction: z.string(),
  /** Memory file paths (display paths like /memories/foo.md) attached to this delegation. */
  memories: z.array(z.string()).prefault([]),
  /** Working directory override (e.g. a git worktree path). */
  workingDirectory: z.string().nullish(),
});

const FileFieldsSchema = z.object({
  inputFiles: z.array(z.string()),
  contextFiles: z.array(z.string()),
  mediaFiles: z.array(z.string()),
  outputFiles: z.array(z.string()),
});

export const WorkflowSpecificFieldsSchema = FileFieldsSchema.extend({
  toolConfig: ToolConfigSchema,
});

/** File fields shape used by all three rendering sites (toolFormatters, RequestPanels, PermissionCard). */
type FileFields = Partial<z.infer<typeof FileFieldsSchema>> & {
  memories?: string[];
};

export interface ProposalFileGroup {
  label: string;
  files: string[];
  /** When false, files are virtual paths that should not be opened via workspace file commands. */
  clickable: boolean;
}

/**
 * Group multi-list file fields into labeled buckets, dropping empties.
 * Post-W4 collapse there is only the multi-list — no separate single-slot
 * to combine — so this is just a per-category list filter.
 */
export function getProposalFileGroups(data: FileFields): ProposalFileGroup[] {
  return [
    {
      label: 'Input',
      files: data.inputFiles ?? [],
      clickable: true,
    },
    {
      label: 'Context',
      files: data.contextFiles ?? [],
      clickable: true,
    },
    {
      label: 'Media',
      files: data.mediaFiles ?? [],
      clickable: true,
    },
    { label: 'Output', files: data.outputFiles ?? [], clickable: true },
    { label: 'Memories', files: data.memories ?? [], clickable: false },
  ].filter((g) => g.files.length > 0);
}
