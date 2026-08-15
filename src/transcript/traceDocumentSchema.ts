import { z } from 'zod';

import { RunRecordSchema } from '@agent/core/definition/RunRecord';
import {
  ExecutionIdSchema,
  ExecutionMetaSchema,
  ExecutionStatusSchema,
  StreamLogEntrySchema,
  StreamSnapshotSchema,
  StreamTabIdSchema,
} from '@shared/schemas';

/** Everything a static trace viewer needs to replay one finished execution. */
export const TraceDocumentSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  /** The run's honest record: AgentConfig for agent runs, minimal otherwise. */
  config: RunRecordSchema,
  meta: ExecutionMetaSchema.nullable(),
  /**
   * Transcript entries. Workflow-call entries have their `data.model` already
   * projected to the runtime display label (via `projectWorkflowCallEntry`) at
   * export time, so an exported trace cannot recover the canonical
   * `WorkflowCallProgress.model` id from that field.
   */
  entries: z.array(StreamLogEntrySchema),
  snapshot: StreamSnapshotSchema,
  /** `null` for executions that predate outcome tracking or never terminated. */
  terminalStatus: ExecutionStatusSchema.nullable(),
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;
