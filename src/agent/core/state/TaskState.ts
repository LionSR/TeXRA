/**
 * The `setTaskState` NDJSON payload shape, projected from `AgentConfig` by
 * `agentConfigToTaskState`. `AgentConfig` is the live run-config vocabulary;
 * this shape exists only for that one frozen wire boundary, whose payload may
 * not change, and is deleted with the S5 version-2 envelope.
 */
import { z } from 'zod';

import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas';

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

const TaskStateSchema = z.union([
  WorkflowTaskStateSchema,
  ToolUseTaskStateSchema,
]);
export type TaskState = z.infer<typeof TaskStateSchema>;
