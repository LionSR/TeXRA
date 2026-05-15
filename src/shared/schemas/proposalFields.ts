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
  inputFile: z.string(),
  inputFiles: z.array(z.string()),
  contextFile: z.string().nullable(),
  contextFiles: z.array(z.string()),
  mediaFile: z.string().nullable(),
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

/** Merge singular + plural file fields into labeled groups, filtering empties. */
export function getProposalFileGroups(data: FileFields): ProposalFileGroup[] {
  const combine = (single: string | null | undefined, arr: string[] = []) =>
    [single, ...arr].filter((f): f is string => Boolean(f));

  return [
    {
      label: 'Input',
      files: combine(data.inputFile, data.inputFiles),
      clickable: true,
    },
    {
      label: 'Context',
      files: combine(data.contextFile, data.contextFiles),
      clickable: true,
    },
    {
      label: 'Media',
      files: combine(data.mediaFile, data.mediaFiles),
      clickable: true,
    },
    { label: 'Output', files: data.outputFiles ?? [], clickable: true },
    { label: 'Memories', files: data.memories ?? [], clickable: false },
  ].filter((g) => g.files.length > 0);
}
