/**
 * Input schema for the executions tool: one action per branch of a
 * discriminated union, plus the provider-quirk normalization that keeps the
 * union readable to structured-output providers.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import { ExecutionIdSchema } from '@shared/schemas';
import {
  EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS,
  EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS,
  executionsWaitTimeoutSeconds,
} from '@shared/toolUse';

// Local file imports
import { ViewRangeSchema } from '../formatting';

/** Virtual path: /executions, /executions/{id}, /executions/{id}/files, /executions/{id}/workspace-files/{path} */
const PathFieldSchema = z.string().describe('Path starting with /executions');

const ViewActionSchema = z.strictObject({
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
  // literal) still merges all five actions into one enum for the
  // OpenAI/Anthropic/Google-facing schema. `.nullish()` here produces an
  // `anyOf` that flattening can't read as a literal, silently dropping
  // wait/kill/subscribe/unsubscribe from the advertised schema instead.
  // The explicit-`null` case AGENTS.md's rule calls out (a structured-output
  // provider representing an omitted optional field as `null` rather than
  // absent) is handled separately below by ExecutionsToolInputSchema's
  // preprocess, which strips a `null` action down to omitted before this
  // branch's own default runs — so the type stays a plain optional literal.
  action: z
    .literal('view')
    .optional()
    .default('view')
    .describe('Read execution data (returns immediately). Default action.'),

  /** Optional line range [start, end] for large outputs. */
  view_range: ViewRangeSchema.nullish().describe(
    'Line range [start, end] for paginating file and background-command output. Conversation pagination uses offset and limit.',
  ),

  /** Zero-based offset for list or conversation pagination. */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the executions list or conversation messages. Use with limit on /executions or /executions/{id}/conversation. Default: 0.',
    ),

  /** Maximum list entries or conversation messages to return. */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries or conversation messages to return. Use on /executions or /executions/{id}/conversation. Default: 100, max: 200.',
    ),
});

const WaitActionSchema = z.strictObject({
  path: PathFieldSchema,
  action: z
    .literal('wait')
    .describe(
      'Wait for a status change on /executions or /executions/{id}, then return the same data as view (avoids sleep-poll loops).',
    ),

  /** Execution IDs to wait on (with /executions only; ignored on /executions/{id}). */
  ids: z
    .array(ExecutionIdSchema)
    .min(1)
    .max(50)
    .nullish()
    .describe(
      'List of execution IDs to wait on (with /executions only). ' +
        'Waits for any of the listed executions to change status. ' +
        'If omitted, waits for any active execution.',
    ),

  /** Max seconds to wait. Default: 300. */
  timeout: z
    .number()
    .finite()
    .nullish()
    // Clamp in the schema so input.timeout is always a ready-to-use number:
    // an out-of-range or missing value becomes a value inside the wait window.
    .transform((v) => executionsWaitTimeoutSeconds(v))
    .describe(
      `Max seconds to wait for a status change. Default: ${EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS}; finite values are clamped to the ${EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS}-${EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS} range.`,
    ),

  /** Zero-based offset for the /executions listing returned once the wait resolves. */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the executions list returned once the wait resolves (with /executions only). Default: 0.',
    ),

  /** Maximum list entries in the /executions listing returned once the wait resolves. */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries in the executions list returned once the wait resolves (with /executions only). Default: 100, max: 200.',
    ),
});

const KillActionSchema = z.strictObject({
  path: PathFieldSchema,
  action: z
    .literal('kill')
    .describe('Terminate a running execution by ID (use on /executions/{id}).'),
});

const SubscribeActionSchema = z.strictObject({
  path: PathFieldSchema,
  action: z
    .literal('subscribe')
    .describe(
      'Receive future status changes for /executions/{id} as <execution-activity> follow-ups; auto-disposes when the execution finishes or this stream is released.',
    ),
});

const UnsubscribeActionSchema = z.strictObject({
  path: PathFieldSchema,
  action: z
    .literal('unsubscribe')
    .describe(
      'Stop receiving <execution-activity> follow-ups for /executions/{id}.',
    ),
});

const ExecutionsToolActionSchema = z.discriminatedUnion('action', [
  ViewActionSchema,
  WaitActionSchema,
  KillActionSchema,
  SubscribeActionSchema,
  UnsubscribeActionSchema,
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
export const ExecutionsToolInputSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === 'object' &&
    'action' in value &&
    value.action === null
  ) {
    const { action: _null, ...rest } = value;
    return rest;
  }
  return value;
}, ExecutionsToolActionSchema);

export type ExecutionsToolInput = z.infer<typeof ExecutionsToolActionSchema>;
