/**
 * Payloads for the run-history arms of `SessionEventDraftSchema`. Shapes
 * only: the arms themselves live in `sessionEvent.ts`, which is the single vocabulary
 * the publisher and both folds switch over.
 *
 * Every arm nests its payload under one key rather than spreading `.shape`
 * into `durable()`. `durable` builds a plain `Schema.Struct`, and spreading a
 * `strictObject`'s shape drops both its strictness and every refinement,
 * which would make the cross-field invariants below decorative at the one
 * boundary where persisted data is validated.
 *
 * No payload references a `commit`. Response identity is a runtime-minted
 * uuid, so no persisted row ever names an ordinal the publisher has not
 * assigned, `RunCell.append` needs no intra-batch reference resolution, and this
 * module needs no import from `sessionEvent.ts` (which imports it).
 */
import { Schema } from 'effect';

import { RetryErrorInfoSchema } from './errors';
import { JsonValueSchema } from './jsonValue';
import { Sha256Schema } from './offeredTools';
import { RunOutcomeSchema } from './run';
import { NormalizedUsageSchema, RunInputSchema } from './runFacts';
import {
  StoredMessageSchema,
  StoredOperationSchema,
  StoredOriginSchema,
  StoredTurnSchema,
} from './storedTurn';
import { SettledAttachmentSchema, SettledToolResultSchema } from './toolResult';

const RunFamilySchema = Schema.Literals(['toolUse']);
/** The loop a `run.position` row belongs to: `toolUse`, the one run program. */
export type RunFamily = typeof RunFamilySchema.Type;

/**
 * One completed provider turn. Runtime-minted when the response row is
 * authored: durable, stable across compaction and branching, and needing no
 * commit resolution. A commit identifies a row; this identifies a response.
 */
const ResponseIdSchema = Schema.String.check(Schema.isUUID());

/**
 * One model invocation and its billed attempt. `attempt` increases only for a
 * retry of the same invocation. The package carries no attempt correlation
 * and retries belong to the runtime, so it lives on the row envelope.
 */
const InvocationRefSchema = Schema.Struct({
  invocationId: Schema.String.check(Schema.isUUID()),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});
/** The decoded invocation reference: its id and the attempt this row is of. */
export type InvocationRef = typeof InvocationRefSchema.Type;

/** Why an invocation is made: a run's turn, or a compaction's summary,
 *  whose rows record its billed calls and nothing the loop continues from. */
const InvocationPurposeSchema = Schema.Literals(['turn', 'summary']);
/** Why an invocation is made, as its attempt rows record it. */
export type InvocationPurpose = typeof InvocationPurposeSchema.Type;

/**
 * What follows a failed attempt: another attempt (`retry`, or `unchain`,
 * which also drops the provider continuation the vendor no longer holds),
 * the person's answer to the retry request `requestId` (`ask`), the end of
 * the invocation as failed (`stop`) or as a user abort (`cancel`).
 */
const FailedNextSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('retry') }),
  Schema.Struct({ kind: Schema.Literal('unchain') }),
  Schema.Struct({
    kind: Schema.Literal('ask'),
    requestId: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal('stop') }),
  Schema.Struct({ kind: Schema.Literal('cancel') }),
]);
/** The move a `failed` row records after its attempt. */
export type FailedNext = typeof FailedNextSchema.Type;

/** The canonical call key: `providerCallId`, never null, so a completed
 *  turn cannot carry a call without an identity. */
const CallIdSchema = Schema.NonEmptyString;

const PositionAtSchema = Schema.Literals([
  'turn.ready',
  'turn.begin',
  'turn.end',
  'response.ready',
  'results.ready',
  'waiting',
  'halted',
]);
/** Where the loop stands at a `run.position` row: before, inside or after a
 *  turn, holding a response or its results, waiting on a person, or halted. */
export type PositionAt = typeof PositionAtSchema.Type;

/** Where the loop stands (`at`, not "step": a step is one model call) and
 *  the turn it stands in: the one record of the loop's position, which the
 *  fold projects to `RunState.phase` and `RunView.position`. */
export const RunPositionPayloadSchema = Schema.Struct({
  family: RunFamilySchema,
  at: PositionAtSchema,
  turn: Schema.optional(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  /** The loop's own terminal word. The canonical terminal fact stays
   *  `run.end`, which also covers failures before the runtime starts. */
  outcome: Schema.optional(Schema.NullOr(RunOutcomeSchema)),
}).check(
  Schema.makeFilter((p) => (p.at === 'halted') === (p.outcome != null), {
    message:
      'Only a halted position carries an outcome, and it always carries one.',
  }),
);

/**
 * Per-call dispatch facts, stamped at append time so the fold and the resume
 * rule stay data-only and need no tool registry. One entry per local-call
 * part of the response, in content order.
 */
const DispatchFactsSchema = Schema.Struct({
  callId: CallIdSchema,
  toolName: Schema.NonEmptyString,
  lane: Schema.Literals(['parallel', 'barrier', 'own']),
  /** The tool's replay declaration when the call was committed: a resume
   *  re-runs an unfinished call unasked only when this and the tool's
   *  current declaration both say `safe`. */
  replay: Schema.Literals(['safe', 'unsafe']),
  /** The primary this call duplicates. A duplicate never executes and never
   *  reapplies its primary's effects. */
  duplicateOf: Schema.NullOr(CallIdSchema),
  /** The call's card id, minted with the response: a slow tool's card opens
   *  under it before the call runs, a fast tool's opens and closes with the
   *  settlement, and a resumed settlement closes the same card. */
  logId: Schema.NonEmptyString,
});
/** The decoded dispatch facts of one call, as a `response` row lists them. */
export type DispatchFacts = typeof DispatchFactsSchema.Type;

/**
 * The payload of a `model.message` row: one step in the life of a model
 * call. An `attempt` leaves the process, the provider is `identified`, the
 * operation is `accepted`, and the call ends as a `response`, as `failed`
 * with the next move, or `cancelled` by the user; an `append` adds messages
 * to the history and `handed-down` records the call the app gives a script's
 * run. The run loop writes every arm; the run state fold reads them back.
 */
export const ModelMessagePayloadSchema = Schema.Union([
  /** A billed request is about to leave the process. Carries no history,
   *  only the address of the rest it sends (`requestContext.ts`). */
  Schema.Struct({
    kind: Schema.Literal('attempt'),
    invocation: InvocationRefSchema,
    purpose: InvocationPurposeSchema,
    request: Sha256Schema,
    origin: StoredOriginSchema,
  }),
  /** Provider identity observed before completion. */
  Schema.Struct({
    kind: Schema.Literal('identified'),
    invocation: InvocationRefSchema,
    providerResponseId: Schema.NonEmptyString,
  }),
  /** The attempt failed: what went wrong, in the runtime's own failure
   *  vocabulary (deliberately not the llm package's `ModelError`), and what
   *  the invoker does next, decided once here so a resume replays it. */
  Schema.Struct({
    kind: Schema.Literal('failed'),
    invocation: InvocationRefSchema,
    purpose: InvocationPurposeSchema,
    error: RetryErrorInfoSchema,
    next: FailedNextSchema,
  }),
  /** The commit barrier: the accepted remote operation, committed before
   *  `observe` is called. `deadlineAtMs` is the limit admitted with the
   *  submission, never one recomputed from current settings; the package
   *  produces neither it nor an attempt, so both ride the envelope. */
  Schema.Struct({
    kind: Schema.Literal('accepted'),
    invocation: InvocationRefSchema,
    operation: StoredOperationSchema,
    deadlineAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  /** A user stop cancelled the accepted operation, as the provider
   *  confirmed. It retires the operation, so a resume starts a new attempt
   *  instead of observing work the user stopped. A cancel not confirmed
   *  leaves no row, and the operation stays observable. */
  Schema.Struct({
    kind: Schema.Literal('cancelled'),
    invocation: InvocationRefSchema,
  }),
  /**
   * A completed provider turn, committed once and reused after restart.
   * `turn` is the storage-owned `StoredTurn`: ordered content, the
   * complete call list, finish reason and observed token counts, with its
   * signatures, encrypted reasoning, native evidence and continuation kept
   * as opaque provider evidence.
   */
  Schema.Struct({
    kind: Schema.Literal('response'),
    responseId: ResponseIdSchema,
    invocation: InvocationRefSchema,
    turn: StoredTurnSchema,
    calls: Schema.Array(DispatchFactsSchema),
    /**
     * The run's priced usage for this turn, stamped by the writer at append
     * beside `calls`, exactly as the dispatch facts are. `turn.usage` is the
     * package's observation: token counts only, with no runtime price and
     * none of the runtime's own accounting metrics. The run's cost is a
     * runtime fact, so the row carries the `NormalizedUsage` the handler
     * produced for this invocation and the fold sums it into
     * `RunState.usage`. `null` only when the provider reported no usage.
     * The rows are the only carrier.
     */
    usage: Schema.NullOr(NormalizedUsageSchema),
  }).check(
    Schema.makeFilter((p) => {
      const local = p.turn.content.filter((part) => part.kind === 'local-call');
      if (local.length !== p.calls.length) {
        return {
          path: ['calls'],
          issue:
            'Every local call of the response has exactly one dispatch fact.',
        };
      }
      const issues: Schema.FilterIssue[] = [];
      const ids = new Set(p.calls.map((c) => c.callId));
      // A duplicate has a primary to reuse, so it names a call that precedes it
      // and is not itself a duplicate. Membership in `ids` alone would admit a
      // call naming itself, which can never settle.
      const earlierPrimaries = new Set<string>();
      p.calls.forEach((call, index) => {
        // Order, identity and tool: a fact that names another tool than the
        // part it stands for is the one the resume rule would dispatch, so the
        // provider's requested tool is bound here, not only its call id.
        if (
          call.callId !== local[index]?.providerCallId ||
          call.toolName !== local[index]?.name
        ) {
          issues.push({
            path: ['calls', index],
            issue:
              'Dispatch facts follow the response call order, identity and tool.',
          });
        }
        if (
          call.duplicateOf != null &&
          !earlierPrimaries.has(call.duplicateOf)
        ) {
          issues.push({
            path: ['calls', index, 'duplicateOf'],
            issue:
              'A duplicate names an earlier non-duplicate call of this same response.',
          });
        }
        if (call.duplicateOf == null) earlierPrimaries.add(call.callId);
      });
      if (ids.size !== p.calls.length) {
        issues.push({ path: ['calls'], issue: 'Duplicate call id.' });
      }
      return issues;
    }),
  ),
  /** The call the app hands a script's run: no model, attempt or usage. */
  Schema.Struct({
    kind: Schema.Literal('handed-down'),
    responseId: ResponseIdSchema,
    call: DispatchFactsSchema,
    argumentsText: Schema.String,
  }),
  /**
   * Canonical messages appended to history, verbatim. When
   * `sourceResponse` is set the row carries ONLY the settlement group
   * (and any accompanying user message). The assistant message is derived
   * by the fold from the pending response's own row, so the paid turn is
   * stored once on an aggregate that never rewrites and never deletes, and
   * no partial group or independently appended pending assistant enters
   * provider history. `input` is what the appended messages change about
   * what the run answers (a fresh run's opening and a delivery record it
   * here); `reason` names a message the loop appended itself, so the turn's
   * policy is read off the rows: `blank-continuation` after a blank turn
   * that followed a tool result, `final-tool` before the forced turn that
   * must submit the structured output.
   */
  Schema.Struct({
    kind: Schema.Literal('append'),
    messages: Schema.Array(StoredMessageSchema).check(Schema.isMinLength(1)),
    sourceResponse: Schema.NullOr(ResponseIdSchema),
    input: Schema.optional(Schema.NullOr(RunInputSchema)),
    reason: Schema.optional(
      Schema.NullOr(Schema.Literals(['blank-continuation', 'final-tool'])),
    ),
  }),
]);

/**
 * The one row that edits the model's view of the run other than by
 * appending: the messages in `range` (`[from, to)` of the history it
 * applies to) are replaced by `messages`. An edit drops the provider-side
 * continuation, which was over the old view, and the offered system text.
 * `trigger` says what asked for a compaction: the threshold
 * (`context-limit`) or the user's `/compact` (`user`); null for the other
 * causes. A fork's seed carries the source's `input` with its messages. `base` is the `seq` of the edit the view stood at when this one
 * was computed (`null`: none), and the fold refuses an edit whose base is no
 * longer the latest. `usage` is a summary call's priced usage, folded as a
 * response's (`null` when no model was called). Compaction (`run/compaction.ts`)
 * and the fork seed (`forkRun.ts`) write it. Whether the result is preparable is the run
 * history's check, at write and cold load: a payload cannot see the
 * history it edits.
 */
export const ContextEditPayloadSchema = Schema.Struct({
  cause: Schema.Literals(['compaction', 'fork']),
  trigger: Schema.NullOr(Schema.Literals(['context-limit', 'user'])),
  base: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  range: Schema.Struct({
    from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    to: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  messages: Schema.Array(StoredMessageSchema),
  usage: Schema.NullOr(NormalizedUsageSchema),
  input: Schema.optional(Schema.NullOr(RunInputSchema)),
}).check(
  Schema.makeFilter(({ range }) => range.from <= range.to, {
    path: ['range'],
    message: 'An edit range ends before it starts.',
  }),
  Schema.makeFilter(
    ({ cause, trigger }) => (cause === 'compaction') === (trigger !== null),
    {
      path: ['trigger'],
      message: 'A compaction names its trigger, and no other cause has one.',
    },
  ),
);

/**
 * One call a `script` call's guest issued: its arguments, which no response
 * carries, and the facts its dispatch needs, committed with the call's first
 * `tool.intent`. A resume replays the script against these rows: the call at
 * `seq` must be this `toolName` with this `input`, or the script diverged.
 */
export const ScriptCallPayloadSchema = Schema.Struct({
  /** The `script` call of the pending response that issued this one. */
  scriptCallId: CallIdSchema,
  /** Issue order inside the script, from 0. */
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `<scriptCallId>/<seq>`. */
  callId: CallIdSchema,
  toolName: Schema.NonEmptyString,
  input: JsonValueSchema,
  /** As a response's dispatch fact records it (`DispatchFacts.replay`). */
  replay: Schema.Literals(['safe', 'unsafe']),
  logId: Schema.NonEmptyString,
  /** The script's stage, which its calls' cards open under. */
  stageId: Schema.NonEmptyString,
  /** The guest's latest `phase()` title when it issued the call. */
  phase: Schema.NullOr(Schema.String),
}).check(
  Schema.makeFilter((p) => p.callId === `${p.scriptCallId}/${p.seq}`, {
    message: 'A script call is named by its script and its issue order.',
  }),
);
/** The decoded shape of {@link ScriptCallPayloadSchema}. */
export type ScriptCallPayload = typeof ScriptCallPayloadSchema.Type;

/** What issued the call whose body an intent starts: a response's dispatch
 *  facts, or the guest of one of its `script` calls (`script.call`). */
const ToolIntentOriginSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('response'),
    responseId: ResponseIdSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('script'), scriptCallId: CallIdSchema }),
]);

/** One call's body starts: committed after its PreToolUse hooks, its guard
 *  and its approval, so before it nothing of the attempt has run and after
 *  it the body may have. */
export const ToolIntentPayloadSchema = Schema.Struct({
  origin: ToolIntentOriginSchema,
  callId: CallIdSchema,
  /** Increases only after a re-run decision: a person's, or the replay rule
   *  for a call whose saved and current declarations both say `safe`. An
   *  earlier approval never authorizes another attempt implicitly. */
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});

/**
 * One call's settlement: what it returned and the attachments captured with
 * it. What the call did to the run (the files it edited, that it ran) is
 * folded from these fields, never restated beside them.
 */
export const ToolResultPayloadSchema = Schema.Struct({
  responseId: ResponseIdSchema,
  callId: CallIdSchema,
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The fold's key fact: a cancelled call is a disposition, never a
   *  match on the English prose of an error message. */
  disposition: Schema.Literals([
    'executed',
    'failed',
    'cancelled',
    'skipped',
    'duplicate',
  ]),
  duplicateOf: Schema.NullOr(CallIdSchema),
  result: SettledToolResultSchema,
  attachments: Schema.Array(SettledAttachmentSchema),
}).check(
  Schema.makeFilter((p) => {
    const issues: Schema.FilterIssue[] = [];
    if ((p.disposition === 'duplicate') !== (p.duplicateOf != null)) {
      issues.push({
        path: ['duplicateOf'],
        issue:
          'A duplicate settlement names its primary, and only a duplicate does.',
      });
    }
    // Both directions. The provider-facing status of the delivered tool group
    // is derived from `result.status` alone, so a call the run recorded as
    // failed, cancelled or skipped carrying an executed result is delivered to
    // the model as a success. A duplicate is the one disposition that copies
    // its primary's status, whichever that was.
    if (
      p.disposition !== 'duplicate' &&
      (p.disposition === 'executed') !== (p.result.status === 'executed')
    ) {
      issues.push({
        path: ['result'],
        issue:
          'An executed disposition requires an executed result, and every other non-duplicate disposition an error result.',
      });
    }
    if (p.disposition === 'duplicate' && p.attachments.length > 0) {
      issues.push("A duplicate never reapplies its primary's effects.");
    }
    return issues;
  }),
);
/** The decoded shape of {@link ToolResultPayloadSchema}. */
export type ToolResultPayload = typeof ToolResultPayloadSchema.Type;
