/**
 * Runtime validation for trace data loaded by `main.ts`'s `loadTrace()` —
 * either fetched (`trace.json`) or inlined (`window.__TEXRA_TRACE__`).
 *
 * This is the trace-viewer's external boundary: the data was authored by
 * whatever TeXRA version produced the export (CLI, extension, or desktop),
 * and `main.ts` has no static guarantee it matches this build's expected
 * shape. Mirrors `TraceDocument` (`@transcript/traceAssembler`) field-for-
 * field while keeping runtime imports browser-safe. `@agent/*` schemas pull
 * extension/runtime dependencies into the trace-viewer bundle, so the agent
 * config and execution meta shapes are mirrored here with type-only
 * compatibility assertions against their source types.
 */
import { z } from 'zod';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionMeta } from '@agent/storage';
import { AgentCategorySchema, AgentSourceSchema } from '@shared/schemas/agent';
import {
  ExecutionIdSchema,
  StreamTabIdSchema,
} from '@shared/schemas/identifiers';
import { NullableFileFieldsSchema } from '@shared/schemas/fileFields';
import { StreamLogEntrySchema } from '@shared/schemas/log';
import {
  ExecutionStatusSchema,
  RunOutcomeSchema,
} from '@shared/schemas/stream';
import { StreamSnapshotSchema } from '@shared/schemas/streamSnapshot';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';
import type { TraceDocument } from '@transcript/traceAssembler';

const TRACE_EXECUTION_META_SCHEMA_VERSION = 1;

const TraceAgentConfigSchema = NullableFileFieldsSchema.extend({
  agent: z.string(),
  agentSource: AgentSourceSchema.nullish(),
  model: z.string(),
  instruction: z.string(),
  displayInstruction: z.string().nullish(),
  agentCategory: AgentCategorySchema,
  editedFiles: z.array(z.string()),
  toolConfig: ToolConfigSchema,
  memories: z.array(z.string()),
  workingDirectory: z.string().nullish(),
  cliOutputFile: z.string().nullish(),
  cliMultiAgentPresetId: z.string().nullish(),
}).superRefine((config, ctx) => {
  if (config.outputFiles.length > config.inputFiles.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputFiles'],
      message:
        'Number of output files must not be greater than the number of input files.',
    });
  }
});

const TraceExecutionMetaSchema = z.object({
  schemaVersion: z.literal(TRACE_EXECUTION_META_SCHEMA_VERSION).prefault(1),
  timestamp: z.string(),
  parentExecutionId: ExecutionIdSchema.optional(),
  terminalStatus: z.string().optional(),
  outcome: RunOutcomeSchema.optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  delegationDepth: z.int().nonnegative().optional(),
});

export const TraceDataSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  config: TraceAgentConfigSchema,
  meta: TraceExecutionMetaSchema.nullable(),
  entries: z.array(StreamLogEntrySchema),
  snapshot: StreamSnapshotSchema,
  terminalStatus: ExecutionStatusSchema.nullable(),
});

export type TraceData = z.infer<typeof TraceDataSchema>;

/**
 * Compile-time check that this schema's inferred shape actually accepts what
 * `assembleTrace` produces — kept in sync with `TraceDocument` rather than a
 * hand-maintained duplicate, so a field added/renamed there surfaces here as
 * a type error instead of a silent validation gap.
 */
type _AssertTraceDataAcceptsTraceDocument = TraceDocument extends TraceData
  ? true
  : never;
type _AssertTraceAgentConfigAcceptsAgentConfig =
  AgentConfig extends z.infer<typeof TraceAgentConfigSchema> ? true : never;
type _AssertTraceExecutionMetaAcceptsExecutionMeta =
  ExecutionMeta extends z.infer<typeof TraceExecutionMetaSchema> ? true : never;

/**
 * Parses raw trace data (from `fetch()` or `window.__TEXRA_TRACE__`) against
 * {@link TraceDataSchema}. Throws a descriptive error identifying the trace
 * file as malformed/incompatible rather than letting an arbitrary shape flow
 * into `replayTrace()` → `dispatchMessage()`, which assumes the shape is
 * already correct and would otherwise fail with a cryptic error deep inside
 * a handler.
 */
export function parseTraceData(raw: unknown): TraceData {
  const result = TraceDataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      'Trace data does not match the expected schema — this trace file may ' +
        'have been exported by an incompatible TeXRA version:\n' +
        z.prettifyError(result.error),
    );
  }
  return result.data;
}
