import { z } from 'zod';

/** Always async. Catch ensures backward compat if legacy 'sync' values are persisted. */
export const ProposalModeSchema = z
  .enum(['sync', 'async'])
  .transform(() => 'async' as const)
  .catch('async' as const);

export const BaseProposalFieldsSchema = z.object({
  agent: z.string(),
  model: z.string(),
  instruction: z.string(),
  mode: ProposalModeSchema,
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
