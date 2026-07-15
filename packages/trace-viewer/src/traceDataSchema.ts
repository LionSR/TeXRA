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
import { AgentCategory, AgentSourceSchema } from '@shared/schemas/agent';
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
import {
  STREAM_SNAPSHOT_SCHEMA_VERSION,
  StreamSnapshotSchema,
} from '@shared/schemas/streamSnapshot';
import { ToolConfigSchema } from '@shared/schemas/toolConfig';
import { AgentDelegationScopeSchema } from '@shared/schemas/agentRoster';
import type { TraceDocument } from '@transcript/traceAssembler';

const TRACE_EXECUTION_META_SCHEMA_VERSION = 1;

const TraceStreamSnapshotSchema = StreamSnapshotSchema.extend({
  schemaVersion: z
    .literal(STREAM_SNAPSHOT_SCHEMA_VERSION)
    .prefault(STREAM_SNAPSHOT_SCHEMA_VERSION),
});

const TraceAgentConfigSharedFieldsSchema = NullableFileFieldsSchema.extend({
  agent: z.string(),
  agentSource: AgentSourceSchema.nullish(),
  model: z.string(),
  instruction: z.string(),
  rootUserInstruction: z.string().nullish(),
  displayInstruction: z.string().nullish(),
  editedFiles: z.array(z.string()),
  toolConfig: ToolConfigSchema,
  memories: z.array(z.string()),
  workingDirectory: z.string().nullish(),
  cliOutputFile: z.string().nullish(),
  cliMultiAgentPresetId: z.string().nullish(),
  delegationAgentScope: AgentDelegationScopeSchema.nullish(),
});

const TraceAgentConfigSchema = z
  .discriminatedUnion('agentCategory', [
    TraceAgentConfigSharedFieldsSchema.extend({
      agentCategory: z.literal(AgentCategory.Workflow),
    }),
    TraceAgentConfigSharedFieldsSchema.extend({
      agentCategory: z.literal(AgentCategory.ToolUse),
    }),
  ])
  .superRefine((config, ctx) => {
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
  streamId: StreamTabIdSchema.optional(),
});

export const TraceDataSchema = z.object({
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  config: TraceAgentConfigSchema,
  meta: TraceExecutionMetaSchema.nullable(),
  entries: z.array(StreamLogEntrySchema),
  snapshot: TraceStreamSnapshotSchema,
  terminalStatus: ExecutionStatusSchema.nullable(),
});

export type TraceData = z.infer<typeof TraceDataSchema>;

/**
 * Compile-time check that this schema's inferred shape actually accepts what
 * `assembleTrace` produces — kept in sync with `TraceDocument` rather than a
 * hand-maintained duplicate, so a field added/renamed there surfaces here as
 * a type error instead of a silent validation gap.
 *
 * Uses the higher-order-function comparison form (as used by type-fest's
 * `IsEqual`) rather than mutual `extends`: for object types, a plain mutual-
 * `extends` check (`[A] extends [B] ? [B] extends [A] ? true : false : false`)
 * treats `{a: string}` and `{a: string; b?: number}` as equal, because a
 * value missing optional property `b` still satisfies both sides. Comparing
 * the types as `G extends A` / `G extends B` conditional-type constructors
 * instead is sensitive to that difference, so an added/removed optional
 * field on either side of the mirror fails this check.
 *
 * Both sides are run through `_Simplify` first, recursively, for two reasons
 * that are false-positive noise rather than real schema drift:
 *  - `AgentConfig` and `ExecutionMeta` are derived via `.superRefine()` /
 *    `.transform()` and end up as intersection types (e.g.
 *    `Base & { outcome?: RunOutcome }`) rather than plain object types. The
 *    HOF comparison treats an intersection and its structurally-identical
 *    flattened object type as *different* conditional-type constructors.
 *  - `TraceDocument` (an authored `interface`) declares its fields
 *    `readonly`, while the corresponding zod-inferred types are mutable. The
 *    HOF comparison is sensitive to that modifier even though it doesn't
 *    reflect an actual shape difference for our purposes, so `_Simplify`
 *    also strips `readonly` (`-readonly`) while preserving each key's
 *    optional/required modifier — the thing we actually want it to catch.
 * Arrays are passed through unsimplified (rather than mapped element-wise):
 * recursing into their element type isn't needed for these three mirrors and
 * empirically trips up the HOF check on unrelated, larger union element
 * types (e.g. `StreamLogEntry`) without adding any real coverage here.
 */
type _AssertTrue<T extends true> = T;
type _Simplify<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: _Simplify<T[K]> }
    : T;
type _IsExact<A, B> =
  (<G>() => G extends _Simplify<A> ? 1 : 2) extends <
    G,
  >() => G extends _Simplify<B> ? 1 : 2
    ? true
    : false;

type _AssertTraceDataAcceptsTraceDocument = _AssertTrue<
  _IsExact<TraceDocument, TraceData>
>;
type _AssertTraceAgentConfigAcceptsAgentConfig = _AssertTrue<
  _IsExact<AgentConfig, z.infer<typeof TraceAgentConfigSchema>>
>;
type _AssertTraceExecutionMetaAcceptsExecutionMeta = _AssertTrue<
  _IsExact<ExecutionMeta, z.infer<typeof TraceExecutionMetaSchema>>
>;

/**
 * Regression coverage for #7265: `_IsExact`'s previous mutual-`extends` form
 * (`[A] extends [B] ? [B] extends [A] ? true : false : false`) considered
 * `{a: string}` and `{a: string; b?: number}` equal in both directions — a
 * value missing an optional property still structurally satisfies both
 * sides — so it silently missed an added/removed optional field on either
 * mirror. This checks the HOF form actually rejects both directions, and
 * still accepts identical shapes (no false positive from the fix itself).
 */
type _AssertFalse<T extends false> = T;
type _AssertCatchesAddedOptionalField = _AssertFalse<
  _IsExact<{ a: string }, { a: string; b?: number }>
>;
type _AssertCatchesRemovedOptionalField = _AssertFalse<
  _IsExact<{ a: string; b?: number }, { a: string }>
>;
type _AssertStillMatchesIdenticalOptionalShape = _AssertTrue<
  _IsExact<{ a: string; b?: number }, { a: string; b?: number }>
>;

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
