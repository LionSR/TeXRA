/**
 * Legacy run-config wrapper. `AgentConfig` is the live run-config vocabulary;
 * this shape survives at exactly two boundaries and has no other callers:
 *
 * - the `meta.taskState` disk-read shim in `StreamSnapshotStore`, which parses
 *   run configs persisted before `runDescriptor`/`executionId` were written;
 * - the frozen CLI NDJSON `setTaskState` event payload, whose wire shape may
 *   not change (projected from `AgentConfig` by `agentConfigToTaskState`).
 */
import { z } from 'zod';

import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas/fileTypes';

import {
  ToolUseAgentConfigSchema,
  WorkflowAgentConfigSchema,
} from '../definition/AgentConfig';

const ActiveFilesSchema = z
  .partialRecord(z.enum(MULTIPLE_DOCUMENT_FILE_TYPES), z.boolean())
  .transform((partial) => {
    const complete = {} as Record<MultipleDocumentFileType, boolean>;
    for (const key of MULTIPLE_DOCUMENT_FILE_TYPES) {
      complete[key] = partial[key] ?? false;
    }
    return complete;
  });

const WorkflowTaskStateSchema = z.object({
  agentConfig: WorkflowAgentConfigSchema,
  activeFiles: ActiveFilesSchema,
});

const ToolUseTaskStateSchema = z.object({
  agentConfig: ToolUseAgentConfigSchema,
});

export const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
