/**
 * Input schema for the executions tool: one action per branch of a
 * discriminated union, plus the provider-quirk normalization that keeps the
 * union readable to structured-output providers.
 */

// Third-party imports
import { Effect, Schema, SchemaGetter } from 'effect';

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
  // Optional + defaulted, NOT .nullish() (unlike every other nullish field in
  // this file): 'view' is the common no-op-preamble call, so omitting
  // `action` must both dispatch to this branch and keep `action` out of the
  // JSON-schema `required` list, matching the pre-refactor `.prefault('view')`
  // and AGENTS.md's "design for the model's first call" rule.
  // `.optional().default('view')` keeps the emitted per-branch JSON schema a
  // clean single-value `const` (not an `anyOf` with `null`) — required so
  // `convertToolSchema`'s `flattenTopLevelUnion`/`schemaLiteralValue` (which
  // only recognizes a bare `const`/one-item `enum` as a discriminator
  // literal) still merges all four actions into one enum for the
  // OpenAI/Anthropic/Google-facing schema. `.nullish()` here produces an
  // `anyOf` that flattening can't read as a literal, silently dropping
  // wait/kill/send from the advertised schema instead.
  // The explicit-`null` case AGENTS.md's rule calls out (a structured-output
  // provider representing an omitted optional field as `null` rather than
  // absent) is handled separately below by ExecutionsToolInputSchema's
  // preprocess, which strips a `null` action down to omitted before this
  // branch's own default runs — so the type stays a plain optional literal.
  action: Schema.optional(Schema.Literal('view'))
    .pipe(Schema.withDecodingDefaultType(Effect.succeed('view')))
    .annotate({
      description: 'Read run data (returns immediately). Default action.',
    }),

  /** Optional line range [start, end] for large outputs. */
  view_range: Schema.optional(Schema.NullOr(ViewRangeSchema)).annotate({
    description:
      'Line range [start, end] for paginating file and background-command output. Conversation pagination uses offset and limit.',
  }),

  /** Zero-based offset for list or conversation pagination. */
  offset: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    0,
  ).describe(
    'Zero-based offset into the executions list or conversation messages. Use with limit on /executions or /executions/{id}/conversation.',
  ),

  /** Maximum list entries or conversation messages to return. */
  limit: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(200),
    ),
    100,
  ).describe(
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
    .pipe(
      Schema.decodeTo(
        Schema.Unknown /* TODO(effect-schema): transform target schema; was `.transform((v) => executionsWaitTimeoutSeconds(v))` */,
        {
          decode: SchemaGetter.transform((v) =>
            executionsWaitTimeoutSeconds(v),
          ),
          encode: SchemaGetter.forbidden(() => 'decode-only'),
        },
      ),
    )
    .annotate({
      description: `Max seconds to wait for a status change. Default: ${EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS}; finite values are clamped to the ${EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS}-${EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS} range.`,
    }),

  /** Zero-based offset for the /executions listing returned once the wait resolves. */
  offset: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    0,
  ).describe(
    'Zero-based offset into the executions list returned once the wait resolves (with /executions only).',
  ),

  /** Maximum list entries in the /executions listing returned once the wait resolves. */
  limit: nullishWithDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(200),
    ),
    100,
  ).describe(
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
  params: nullishWithDefault(Schema.Array(Schema.String), []).describe(
    'Values for the ? placeholders in sql, in order, bound as text.',
  ),
});

const ExecutionsToolActionSchema = Schema.Union([
  ViewActionSchema,
  WaitActionSchema,
  KillActionSchema,
  SendActionSchema,
  QueryActionSchema,
]);

// A structured-output provider represents an omitted optional field as an
// explicit `action: null` rather than leaving the key absent (AGENTS.md's
// tool-input-schema rule). z.discriminatedUnion reads the raw `action` value
// to pick a branch before any field-level default runs, and `null` isn't one
// of the branch literals, so strip it down to "key absent" here — the view
// branch's own `.optional().default('view')` then takes over exactly as it
// does for a truly omitted key. A genuinely absent key needs no help: Zod
// already matches that against the one branch whose discriminator accepts
// undefined.
export const ExecutionsToolInputSchema =
  ExecutionsToolActionSchema; /* TODO(effect-schema): preprocess; was `z.preprocess((value) => { if ( value && typeof value === 'object' && 'action' in value && value.action === null ) { const { action: _null, ...rest } = value; return rest; } return value; }, ExecutionsToolActionSchema)` */

export type ExecutionsToolInput = typeof ExecutionsToolActionSchema.Type;
