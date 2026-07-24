import { z } from 'zod';

const WorkflowScriptFileListSchema = z
  .array(z.string().trim().min(1))
  .readonly();

/** Files bound to a workflow-script run, separated by workflow-agent role. */
export const WorkflowScriptFilesSchema = z
  .strictObject({
    inputFiles: WorkflowScriptFileListSchema.prefault([]),
    contextFiles: WorkflowScriptFileListSchema.prefault([]),
    mediaFiles: WorkflowScriptFileListSchema.prefault([]),
  })
  .readonly();

export type WorkflowScriptFiles = z.infer<typeof WorkflowScriptFilesSchema>;
