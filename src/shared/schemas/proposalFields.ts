import { z } from 'zod';

export const BaseProposalFieldsSchema = z.object({
  agent: z.string(),
  model: z.string(),
  instruction: z.string(),
  /** Memory file paths (display paths like /memories/foo.md) attached to this delegation. */
  memories: z.array(z.string()).prefault([]),
});

const FileFieldsSchema = z.object({
  inputFile: z.string(),
  inputFiles: z.array(z.string()),
  referenceFile: z.string().nullable(),
  referenceFiles: z.array(z.string()),
  auxiliaryFile: z.string().nullable(),
  auxiliaryFiles: z.array(z.string()),
  mediaFile: z.string().nullable(),
  mediaFiles: z.array(z.string()),
  outputFiles: z.array(z.string()),
});

export const WorkflowSpecificFieldsSchema = FileFieldsSchema.extend({
  useMultipleOutputs: z.boolean(),
});

/** File fields shape used by all three rendering sites (toolFormatters, RequestPanels, PermissionCard). */
type FileFields = Partial<z.infer<typeof FileFieldsSchema>> & {
  memories?: string[];
};

/** Merge singular + plural file fields into labeled groups, filtering empties. */
export function getProposalFileGroups(
  data: FileFields,
): Array<{ label: string; files: string[] }> {
  const combine = (single: string | null | undefined, arr: string[] = []) =>
    [single, ...arr].filter((f): f is string => Boolean(f));

  return [
    { label: 'Input', files: combine(data.inputFile, data.inputFiles) },
    {
      label: 'Reference',
      files: combine(data.referenceFile, data.referenceFiles),
    },
    {
      label: 'Auxiliary',
      files: combine(data.auxiliaryFile, data.auxiliaryFiles),
    },
    { label: 'Media', files: combine(data.mediaFile, data.mediaFiles) },
    { label: 'Output', files: data.outputFiles ?? [] },
    { label: 'Memories', files: data.memories ?? [] },
  ].filter((g) => g.files.length > 0);
}
