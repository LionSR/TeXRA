import { z } from 'zod';

import { RunRecordSchema } from '@agent/core/definition/RunRecord';
import {
  RunIdSchema,
  RunMetaSchema,
  StreamLogEntrySchema,
  RunSnapshotSchema,
} from '@shared/schemas';

/** Everything a static trace viewer needs to replay one finished run. */
export const TraceDocumentSchema = z.object({
  runId: RunIdSchema,
  /** The run's honest record: AgentConfig for agent runs, minimal otherwise. */
  config: RunRecordSchema,
  meta: RunMetaSchema,
  /**
   * Transcript entries. Workflow-call entries have their `data.model` already
   * projected to the runtime display label (via `projectWorkflowCallEntry`) at
   * export time, so an exported trace cannot recover the canonical
   * `WorkflowCallProgress.model` id from that field.
   */
  entries: z.array(StreamLogEntrySchema),
  snapshot: RunSnapshotSchema,
});

export type TraceDocument = Readonly<z.infer<typeof TraceDocumentSchema>>;
