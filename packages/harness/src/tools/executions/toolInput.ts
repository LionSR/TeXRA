/**
 * Input schema for the executions tool: one action per branch of a union.
 */

// Third-party imports
import { Option, Schema, SchemaGetter } from 'effect';

// Local imports
import { RunIdSchema } from '@shared/schemas';
import {
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
  executionsWaitTimeoutSeconds,
} from '@shared/toolUse';

// Local file imports
import { nullishWithDefault } from '../core/inputSchema';
import { ViewRangeSchema } from '../formatting';

/** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/workspace-files/{path} */
const PathFieldSchema = Schema.String.annotate({
  description: 'Path starting with /executions',
});

const ViewActionSchema = Schema.Struct({
  path: PathFieldSchema,
  // `view` is the common no-op-preamble call, so an omitted `action` must
  // dispatch to this branch, and a structured-output provider's explicit
  // `action: null` (AGENTS.md's tool-input-schema rule) must too: a union
  // picks the first branch that decodes, and this is the only one whose
  // `action` takes null and absence.
  action: nullishWithDefault(
    Schema.Literal('view'),
    'view',
    'Read run data (returns immediately). Default action.',
  ),

  /** Optional line range [start, end] for large outputs. */
  view_range: Schema.optional(Schema.NullOr(ViewRangeSchema)).annotate({
    description:
      'Line range [start, end] for paginating file and background-command output. Conversation pagination uses offset and limit.',
  }),

  /** Zero-based offset for list or conversation pagination. */
  offset: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    0,
    'Zero-based offset into the executions list or conversation messages. Use with limit on /executions or /executions/{id}/conversation.',
  ),

  /** Maximum list entries or conversation messages to return. */
  limit: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(200),
    ),
    100,
    'Max entries or conversation messages to return. Use on /executions or /executions/{id}/conversation. Max: 200.',
  ),
});

const WaitActionSchema = Schema.Struct({
  path: PathFieldSchema,
  action: Schema.Literal('wait').annotate({
    description:
      'Wait for a status change on /executions or /executions/{id}, then return the same data as view (avoids sleep-poll loops).',
  }),

  /** Run IDs to wait on (with /executions only; ignored on /executions/{id}). */
  ids: Schema.optional(
    Schema.NullOr(
      Schema.Array(RunIdSchema)
        .check(Schema.isMinLength(1))
        .check(Schema.isMaxLength(50)),
    ),
  ).annotate({
    description:
      'List of run IDs to wait on (with /executions only). ' +
      'Waits for any of the listed executions to change status. ' +
      'If omitted, waits for any active run.',
  }),

  /** Max seconds to wait. Default: 300. */
  timeout: Schema.optional(Schema.NullOr(Schema.Finite))
    .annotate({
      description: `Max seconds to wait for a status change. Default: ${EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS}; finite values are clamped to the ${EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS}-${EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS} range.`,
    })
    .pipe(
      Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transformOptional((value) =>
          Option.some(
            executionsWaitTimeoutSeconds(Option.getOrUndefined(value)),
          ),
        ),
        encode: SchemaGetter.passthrough(),
      }),
    ),

  /** Zero-based offset for the /executions listing returned once the wait resolves. */
  offset: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    0,
    'Zero-based offset into the executions list returned once the wait resolves (with /executions only).',
  ),

  /** Maximum list entries in the /executions listing returned once the wait resolves. */
  limit: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(200),
    ),
    100,
    'Max entries in the executions list returned once the wait resolves (with /executions only). Max: 200.',
  ),
});

const KillActionSchema = Schema.Struct({
  path: PathFieldSchema,
  action: Schema.Literal('kill').annotate({
    description: 'Terminate a live run by ID (use on /executions/{id}).',
  }),
});

const SendActionSchema = Schema.Struct({
  path: PathFieldSchema,
  action: Schema.Literal('send').annotate({
    description:
      "Put a message on another run's input (use on /executions/{id}). It is read when that run finishes its current turn; a one-shot run takes none. A reply, if any, arrives as your own follow-up.",
  }),
  message: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'The message for the run.',
  }),
});

// `path` stays required here as on every arm: the provider-facing schema
// flattens this union and keeps a field required only if every arm requires
// it (`flattenTopLevelUnion`), so an optional one would loosen all four.
const QueryActionSchema = Schema.Struct({
  path: PathFieldSchema,
  action: Schema.Literal('query').annotate({
    description:
      'Run one read-only SQL statement over the run-history views listed in the description (use on /executions).',
  }),
  sql: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      'One SELECT, WITH, EXPLAIN or VALUES statement; bind values as ?.',
  }),
  params: nullishWithDefault(
    Schema.Array(Schema.String),
    [],
    'Values for the ? placeholders in sql, in order, bound as text.',
  ),
});

/** The `executions` tool's input: one of its actions (view, wait, kill, send, query). */
export const ExecutionsToolInputSchema = Schema.Union([
  ViewActionSchema,
  WaitActionSchema,
  KillActionSchema,
  SendActionSchema,
  QueryActionSchema,
]);

/** A decoded `executions` tool input. */
export type ExecutionsToolInput = typeof ExecutionsToolInputSchema.Type;
