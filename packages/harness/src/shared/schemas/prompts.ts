import { Effect, Schema, Struct } from 'effect';

import { RetryErrorInfoSchema } from './errors';
import { RunSelectionSchema, RunIdSchema, Sha256Schema } from './identifiers';
import { LineCountSchema } from './lineChanges';
import { PlanSchema } from './plan';
import { MODEL_PROVIDERS } from './runInput';
import {
  BaseProposalFieldsSchema,
  TaskProposalFieldsSchema,
} from './proposalFields';
import { DeclinableUsageRouteSchema } from './usage';

/** Common permission request fields */
const PermissionBaseSchema = Schema.Struct({
  requestId: Schema.String,
  allowBypass: Schema.Boolean,
  runId: RunSelectionSchema,
});

export const ToolEditPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    path: Schema.String,
    relativePath: Schema.String,
    sourceTool: Schema.String,
    addedLines: LineCountSchema,
    removedLines: LineCountSchema,
    /** The address of the proposal's content (`ToolEditContent`: the
     *  original and proposed text with their diff) in the session's blob
     *  store, stored with the request's row; `request.preview` reads it. */
    content: Sha256Schema,
  }),
);
export type ToolEditPermission = typeof ToolEditPermissionSchema.Type;

/** One unified-diff hunk: the line ranges it spans on each side, and its
 *  lines, each marked ` `, `-` or `+` (`\` notes a missing final newline). */
const DiffHunkSchema = Schema.Struct({
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  lines: Schema.Array(Schema.String),
});

/** What a pending tool edit would change: the original and proposed
 *  content a host shows beside the request's path and line counts, and
 *  the diff between them, computed once where the request is built: its
 *  hunks and the 0-based line of the proposed text a diff view reveals
 *  first (null when nothing changed). `request.preview` reads the stored
 *  proposal named by `ToolEditPermission.content` and renders a missing
 *  original file as empty text. The stored proposal distinguishes absence
 *  from an empty file so applying it detects concurrent creation. */
export const ToolEditContentSchema = Schema.Struct({
  originalContent: Schema.String,
  proposedContent: Schema.String,
  hunks: Schema.Array(DiffHunkSchema),
  firstChangedLine: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
/** A pending tool edit's content. */
export type ToolEditContent = typeof ToolEditContentSchema.Type;

/**
 * Hunks as unified-diff text lines, each preceded by its header. One header
 * policy: a `,1` range is omitted, the form `diff -u` and `git diff` emit.
 */
export function formatHunkLines(hunks: ToolEditContent['hunks']): string[] {
  const range = (start: number, lines: number) =>
    lines === 1 ? String(start) : `${start},${lines}`;
  return hunks.flatMap((hunk) => [
    `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    ...hunk.lines,
  ]);
}

// Null records a missing file; an empty string records an existing empty one.
// The preview wire contract renders either as empty text.
const StoredToolEditContentSchema = ToolEditContentSchema.mapFields(
  Struct.assign({ originalContent: Schema.NullOr(Schema.String) }),
);

/** Read the proposal named by a durable edit request. A missing or malformed
 *  blob is a corrupt store, never permission to use a recomputed proposal. */
export const readToolEditContent = (
  readBlobs: (
    digests: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, Error>,
  address: ToolEditPermission['content'],
): Effect.Effect<typeof StoredToolEditContentSchema.Type> =>
  Effect.map(Effect.orDie(readBlobs([address])), (held) => {
    const text = held.get(address);
    if (text === undefined)
      throw new Error(`The store holds no tool edit proposal at ${address}`);
    return Schema.decodeUnknownSync(
      Schema.fromJsonString(StoredToolEditContentSchema),
    )(text);
  });

export const BashPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
  }),
);
export type BashPermission = typeof BashPermissionSchema.Type;

/**
 * The API-key providers a stored retry offer names. Storage owns the enum
 * (the llm catalog's `ApiKeyProviderId` must stay assignable to it, which
 * `credentialSwitch` checks where it builds an offer), so a catalog
 * change is never a silent stored format change.
 */
const ApiKeyProviderIdSchema = Schema.Literals([
  ...MODEL_PROVIDERS,
  'kimiCode',
]);

/**
 * The move onto the user's own credential a failed model request offers,
 * decided once by the retry owner (`ModelInvoker`) from the recorded failure
 * and the route the failed model was bound on. Hosts render it; none of them
 * re-derives it from the error.
 */
export const CredentialSwitchSchema = Schema.Union([
  /** A subscription or coding-plan quota ran out: the run declines `route`
   *  and retries on the model's own `provider` key. `automatic` records that
   *  the invoker took the switch itself (a coding plan whose fallback key is
   *  already stored), so no one was asked. */
  Schema.Struct({
    kind: Schema.Literal('decline-route'),
    route: DeclinableUsageRouteSchema,
    provider: ApiKeyProviderIdSchema,
    automatic: Schema.Boolean,
  }),
  /** The account behind the stored `provider` key is out of credit, so only
   *  a changed key can succeed. */
  Schema.Struct({
    kind: Schema.Literal('new-key'),
    provider: ApiKeyProviderIdSchema,
  }),
]);
export type CredentialSwitch = typeof CredentialSwitchSchema.Type;

export const RetryPermissionSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  operation: Schema.String,
  model: Schema.optional(Schema.String),
  /** The failure as the run recorded it: the harness's plain message and
   *  the facts a host words it from (its classification). */
  errorDetails: RetryErrorInfoSchema,
  /** Null or absent when the failure offers no credential move. */
  credentialSwitch: Schema.optional(Schema.NullOr(CredentialSwitchSchema)),
});
export type RetryPermission = typeof RetryPermissionSchema.Type;

/**
 * A delegation awaiting approval: the agent and its prompt, and, for a
 * task (`task`), the files it works over and the options its plugin
 * gives it. A chat delegation has neither.
 */
export const AgentProposalSchema = BaseProposalFieldsSchema.mapFields(
  Struct.assign(TaskProposalFieldsSchema.fields),
).mapFields(
  Struct.assign({
    /** Runs the agent's task over the files, not a conversation. */
    task: Schema.Boolean,
    rootUserInstruction: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type AgentProposal = typeof AgentProposalSchema.Type;

export const AgentProposalPermissionSchema = AgentProposalSchema.mapFields(
  Struct.assign({
    requestId: Schema.String,
    /** Whether a grant turned on while it waits answers it: false when a
     *  hook asked for this review. */
    allowBypass: Schema.Boolean,
    runId: RunIdSchema,
  }),
);
export type AgentProposalPermission =
  (typeof AgentProposalPermissionSchema)['Type'];

// ============================================================================
// User Question
// ============================================================================

const UserQuestionOptionSchema = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

export const UserQuestionPromptSchema = Schema.Struct({
  question: Schema.String.check(Schema.isMinLength(1)),
  header: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(12))),
  ),
  options: Schema.Array(UserQuestionOptionSchema)
    .check(Schema.isMinLength(2))
    .check(Schema.isMaxLength(4)),
  multiSelect: Schema.optional(Schema.NullOr(Schema.Boolean)),
  allowFreeText: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;

export const UserQuestionAnswersSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type UserQuestionAnswers = typeof UserQuestionAnswersSchema.Type;

export const UserQuestionPermissionSchema = PermissionBaseSchema.mapFields(
  Struct.assign({
    questions: Schema.Array(UserQuestionPromptSchema)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(3)),
    context: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
export type UserQuestionPermission =
  (typeof UserQuestionPermissionSchema)['Type'];

// ============================================================================
// Plan Approval
// ============================================================================

export const PlanApprovalPermissionSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  plan: PlanSchema,
});
export type PlanApprovalPermission =
  (typeof PlanApprovalPermissionSchema)['Type'];
