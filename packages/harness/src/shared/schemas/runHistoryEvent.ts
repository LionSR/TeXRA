/**
 * Payloads for the run-history arms of `SessionEventDraftSchema`. Shapes
 * only: the arms themselves live in `sessionEvent.ts`, which is the single vocabulary
 * the publisher and both folds switch over.
 *
 * Every arm nests its payload under one key rather than spreading `.shape`
 * into `durable()`. `durable` builds a plain `z.object`, and spreading a
 * `strictObject`'s shape drops both its strictness and every refinement,
 * which would make the cross-field invariants below decorative at the one
 * boundary where persisted data is validated.
 *
 * No payload references a `commit`. Response identity is a runtime-minted
 * uuid, so no persisted row ever names an ordinal the publisher has not
 * assigned, `appendBatch` needs no intra-batch reference resolution, and this
 * module needs no import from `sessionEvent.ts` (which imports it).
 */
import { z } from 'zod';

import { RetryErrorInfoSchema } from './errors';
import { JsonValueSchema } from './jsonValue';
import { Sha256Schema } from './offeredTools';
import { RunOutcomeSchema } from './run';
import {
  ModelBackendSchema,
  NormalizedUsageSchema,
  ToolUseSnapshotStateSchema,
} from './runSnapshotState';
import {
  ProviderEvidenceSchema,
  StoredMessageSchema,
  StoredOperationSchema,
  StoredOriginSchema,
  StoredTurnSchema,
} from './storedTurn';
import { SettledAttachmentSchema, SettledToolResultSchema } from './toolResult';
import { DeclinableUsageRouteSchema } from './usage';

/* ------------------------------------------------------------------ ids */

const RunFamilySchema = z.enum(['toolUse']);
export type RunFamily = z.infer<typeof RunFamilySchema>;

/**
 * One completed provider turn. Runtime-minted when the response row is
 * authored: durable, stable across compaction and branching, and needing no
 * commit resolution. A commit identifies a row; this identifies a response.
 */
const ResponseIdSchema = z.uuid();

/**
 * One model invocation and its billed attempt. `attempt` increases only for a
 * retry of the same invocation. The package carries no attempt correlation
 * and retries belong to the runtime, so it lives on the row envelope (D2).
 */
const InvocationRefSchema = z.strictObject({
  invocationId: z.uuid(),
  attempt: z.int().positive(),
});
export type InvocationRef = z.infer<typeof InvocationRefSchema>;

/** The canonical call key: `providerCallId`, non-nullable since L5, so a
 *  completed turn cannot carry a call without an identity. */
const CallIdSchema = z.string().min(1);

/* ---------------------------------------------------------- run.position */

const PositionAtSchema = z.enum([
  'turn.ready',
  'turn.begin',
  'turn.end',
  'response.ready',
  'results.ready',
  'waiting',
  'halted',
]);
export type PositionAt = z.infer<typeof PositionAtSchema>;

/** Where the loop stands (`at`, not "step": a step is one model call) and
 *  the turn it stands in: the one record of the loop's position, which the
 *  fold projects to `RunState.phase` and `RunView.position`. */
export const RunPositionPayloadSchema = z
  .strictObject({
    family: RunFamilySchema,
    at: PositionAtSchema,
    turn: z.int().nonnegative().nullish(),
    /** The loop's own terminal word. The canonical terminal fact stays
     *  `run.end`, which also covers failures before the runtime starts. */
    outcome: RunOutcomeSchema.nullish(),
  })
  .refine(
    (p) => (p.at === 'halted') === (p.outcome != null),
    'Only a halted position carries an outcome, and it always carries one.',
  );

/* ---------------------------------------------------------- model.message */

/**
 * Per-call dispatch facts, stamped at append time so the fold and the resume
 * rule stay data-only and need no tool registry. One entry per local-call
 * part of the response, in content order.
 */
const DispatchFactsSchema = z.strictObject({
  callId: CallIdSchema,
  toolName: z.string().min(1),
  ordinal: z.int().nonnegative(),
  parallelSafe: z.boolean(),
  /** The tool's replay declaration when the call was committed: a resume
   *  re-runs an unfinished call unasked only when this and the tool's
   *  current declaration both say `safe`. */
  replay: z.enum(['safe', 'unsafe']),
  /** The primary this call duplicates. A duplicate never executes and never
   *  reapplies its primary's effects. */
  duplicateOf: CallIdSchema.nullable(),
  /** The call's card id, minted with the response: a slow tool's card opens
   *  under it before the call runs, a fast tool's opens and closes with the
   *  settlement, and a resumed settlement closes the same card. */
  logId: z.string().min(1),
  stageId: z.string().min(1).nullable(),
});
export type DispatchFacts = z.infer<typeof DispatchFactsSchema>;

export const ModelMessagePayloadSchema = z
  .discriminatedUnion('kind', [
    /** A billed request is about to leave the process. Carries no history,
     *  only the address of the rest it sends (`requestContext.ts`). */
    z.strictObject({
      kind: z.literal('attempt'),
      invocation: InvocationRefSchema,
      request: Sha256Schema,
      origin: StoredOriginSchema,
      delivery: z.enum(['stream', 'blocking', 'background']),
    }),
    /** Provider identity observed before completion. */
    z.strictObject({
      kind: z.literal('identified'),
      invocation: InvocationRefSchema,
      providerResponseId: z.string().min(1),
      returnedModel: z.string().min(1).nullable(),
    }),
    /** The commit barrier: the accepted remote operation, committed before
     *  `observe` is called. `deadlineAtMs` is the limit admitted with the
     *  submission, never one recomputed from current settings; the package
     *  produces neither it nor an attempt, so both ride the envelope (D2). */
    z.strictObject({
      kind: z.literal('accepted'),
      invocation: InvocationRefSchema,
      operation: StoredOperationSchema,
      deadlineAtMs: z.int().positive(),
    }),
    /** A user stop cancelled the accepted operation; `evidence` is the
     *  provider's reply verbatim. It retires the operation, so a resume starts
     *  a new attempt instead of observing work the user stopped. A cancel that
     *  failed leaves no row, and the still-live operation stays observable. */
    z.strictObject({
      kind: z.literal('cancelled'),
      invocation: InvocationRefSchema,
      evidence: ProviderEvidenceSchema,
    }),
    /**
     * A completed provider turn, committed once and reused after restart.
     * `turn` is the storage-owned `StoredTurn`: ordered content, the
     * complete call list, finish reason and observed token counts, with its
     * signatures, encrypted reasoning, native evidence and continuation kept
     * as opaque provider evidence.
     */
    z.strictObject({
      kind: z.literal('response'),
      responseId: ResponseIdSchema,
      invocation: InvocationRefSchema,
      turn: StoredTurnSchema,
      calls: z.array(DispatchFactsSchema).readonly(),
      /**
       * The run's priced usage for this turn, stamped by the writer at append
       * beside `calls`, exactly as the dispatch facts are. `turn.usage` is the
       * package's observation: token counts only, with no runtime price and
       * none of the runtime's own accounting metrics. The run's cost is a
       * runtime fact, so the row carries the `NormalizedUsage` the handler
       * produced for this invocation and the fold sums it into
       * `RunState.usage` (D12). `null` only when the invocation produced no
       * usage at all: an editor turn, or a provider that reported none.
       * Never restored from a snapshot; the rows are the only carrier.
       */
      usage: NormalizedUsageSchema.nullable(),
    }),
    /** The call the app hands a script's run: no model, attempt or usage. */
    z.strictObject({
      kind: z.literal('handed-down'),
      responseId: ResponseIdSchema,
      call: DispatchFactsSchema,
      argumentsText: z.string(),
    }),
    /**
     * Canonical messages appended to history, verbatim. When
     * `sourceResponse` is set the row carries ONLY the settlement group
     * (and any accompanying user message). The assistant message is derived
     * by the fold from the pending response's own row, so the paid turn is
     * stored once on an aggregate that never rewrites and never deletes, and
     * no partial group or independently appended pending assistant enters
     * provider history.
     */
    z.strictObject({
      kind: z.literal('append'),
      messages: z.array(StoredMessageSchema).min(1).readonly(),
      sourceResponse: ResponseIdSchema.nullable(),
    }),
  ])
  .superRefine((p, ctx) => {
    if (p.kind !== 'response') return;
    // The editor arm has no local calls.
    if (p.turn.kind !== 'http') {
      if (p.calls.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls'],
          message: 'An editor turn dispatches no local calls.',
        });
      }
      return;
    }
    const local = p.turn.content.filter((part) => part.kind === 'local-call');
    if (local.length !== p.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message:
          'Every local call of the response has exactly one dispatch fact.',
      });
      return;
    }
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
        call.ordinal !== index ||
        call.callId !== local[index]?.providerCallId ||
        call.toolName !== local[index]?.name
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index],
          message:
            'Dispatch facts follow the response call order, identity and tool.',
        });
      }
      if (call.duplicateOf != null && !earlierPrimaries.has(call.duplicateOf)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'duplicateOf'],
          message:
            'A duplicate names an earlier non-duplicate call of this same response.',
        });
      }
      if (call.duplicateOf == null) earlierPrimaries.add(call.callId);
    });
    if (ids.size !== p.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'Duplicate call id.',
      });
    }
  });

/* ----------------------------------------------------------- context.edit */

/**
 * The one row that edits the model's view of the run other than by
 * appending: the messages in `range` (`[from, to)` of the history it
 * applies to) are replaced by `messages`. An edit drops the provider-side
 * continuation, which was over the old view, and the offered system text.
 * `trigger` says what asked for a compaction: the threshold
 * (`context-limit`), an overflowed window (`context-window`), a model
 * switch (`model-switch`, an empty range: the history stays, the
 * continuation goes) or the user's `/compact` (`user`); null for the other
 * causes. `base` is the `seq` of the edit the view stood at when this one
 * was computed (`null`: none), and the fold refuses an edit whose base is no
 * longer the latest. `usage` is a summary call's priced usage, folded as a
 * response's (`null` when no model was called). Compaction (`run/compaction.ts`,
 * `loop/modelSwitch.ts`), reset and handoff (`FollowUps.ts`) and the fork
 * seed (`forkRun.ts`) write it. Whether the result is preparable is the run
 * history's check (D11), at write and cold load: a payload cannot see the
 * history it edits.
 */
export const ContextEditPayloadSchema = z
  .strictObject({
    cause: z.enum(['compaction', 'reset', 'handoff', 'fork']),
    trigger: z
      .enum(['context-limit', 'context-window', 'model-switch', 'user'])
      .nullable(),
    base: z.int().positive().nullable(),
    range: z.strictObject({
      from: z.int().nonnegative(),
      to: z.int().nonnegative(),
    }),
    messages: z.array(StoredMessageSchema).readonly(),
    usage: NormalizedUsageSchema.nullable(),
  })
  .refine(({ range }) => range.from <= range.to, {
    path: ['range'],
    message: 'An edit range ends before it starts.',
  })
  .refine(
    ({ cause, trigger }) => (cause === 'compaction') === (trigger !== null),
    {
      path: ['trigger'],
      message: 'A compaction names its trigger, and no other cause has one.',
    },
  );

/* ------------------------------------------------------------ script.call */

/**
 * One call a `script` call's guest issued: its arguments, which no response
 * carries, and the facts its dispatch needs, committed with the call's first
 * `tool.intent`. A resume replays the script against these rows: the call at
 * `seq` must be this `toolName` with this `input`, or the script diverged.
 */
export const ScriptCallPayloadSchema = z
  .strictObject({
    /** The `script` call of the pending response that issued this one. */
    scriptCallId: CallIdSchema,
    /** Issue order inside the script, from 0. */
    seq: z.int().nonnegative(),
    /** `<scriptCallId>/<seq>`. */
    callId: CallIdSchema,
    toolName: z.string().min(1),
    input: JsonValueSchema,
    /** As a response's dispatch fact records it (`DispatchFacts.replay`). */
    replay: z.enum(['safe', 'unsafe']),
    logId: z.string().min(1),
    /** The script's stage, which its calls' cards open under. */
    stageId: z.string().min(1),
    /** The guest's latest `phase()` title when it issued the call. */
    phase: z.string().nullable(),
  })
  .refine(
    (p) => p.callId === `${p.scriptCallId}/${p.seq}`,
    'A script call is named by its script and its issue order.',
  );
export type ScriptCallPayload = z.infer<typeof ScriptCallPayloadSchema>;

/* ------------------------------------------------------------ tool.intent */

/** What issued the call whose body an intent starts: a response's dispatch
 *  facts, or the guest of one of its `script` calls (`script.call`). */
const ToolIntentOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('response'), responseId: ResponseIdSchema }),
  z.strictObject({ kind: z.literal('script'), scriptCallId: CallIdSchema }),
]);

/** One call's body starts: committed after its PreToolUse hooks, its guard
 *  and its approval, so before it nothing of the attempt has run and after
 *  it the body may have. */
export const ToolIntentPayloadSchema = z.strictObject({
  origin: ToolIntentOriginSchema,
  callId: CallIdSchema,
  /** Increases only after a re-run decision: a person's, or the replay rule
   *  for a call whose saved and current declarations both say `safe`. An
   *  earlier approval never authorizes another attempt implicitly. */
  attempt: z.int().positive(),
});

/* ----------------------------------------------------------- tool.binding */

/** The request that guards one call attempt: the single carrier of an
 *  intent's binding, committed beside the `request.opened` it names, so a
 *  restart neither cancels the request nor loses the call it parks.
 *  `attempt` is the intent attempt it guards, so a later dispatch of the same
 *  call needs its own binding. `role` says what the answer decides: `call`
 *  is the call's own request (its guard's approval, or the first request its
 *  body raised), whose answer completes the attempt, and a resume re-enters
 *  it while it stands; `outcome` is the loop's question for an attempt whose
 *  outcome is unknown, whose answer re-runs or skips the call. */
export const ToolBindingPayloadSchema = z.strictObject({
  callId: CallIdSchema,
  attempt: z.int().positive(),
  requestId: z.string().min(1),
  role: z.enum(['call', 'outcome']),
});
export type ToolBindingPayload = z.infer<typeof ToolBindingPayloadSchema>;

/* ------------------------------------------------------------ tool.result */

/**
 * One call's settlement: what it returned and the attachments captured with
 * it. What the call did to the run (the files it edited, that it ran) is
 * folded from these fields, never restated beside them.
 */
export const ToolResultPayloadSchema = z
  .strictObject({
    responseId: ResponseIdSchema,
    callId: CallIdSchema,
    attempt: z.int().positive(),
    /** The fold's key fact: a cancelled call is a disposition, never a
     *  match on the English prose of an error message. */
    disposition: z.enum([
      'executed',
      'failed',
      'cancelled',
      'skipped',
      'duplicate',
    ]),
    duplicateOf: CallIdSchema.nullable(),
    result: SettledToolResultSchema,
    attachments: z.array(SettledAttachmentSchema).readonly(),
  })
  .superRefine((p, ctx) => {
    if ((p.disposition === 'duplicate') !== (p.duplicateOf != null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicateOf'],
        message:
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
      ctx.addIssue({
        code: 'custom',
        path: ['result'],
        message:
          'An executed disposition requires an executed result, and every other non-duplicate disposition an error result.',
      });
    }
    if (p.disposition === 'duplicate' && p.attachments.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: "A duplicate never reapplies its primary's effects.",
      });
    }
  });
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;

/* ------------------------------------------------------------ model.retry */

const PendingRetrySchema = z.strictObject({
  requestId: z.string().min(1),
  invocation: InvocationRefSchema,
  failedModelId: z.string().min(1),
  /** Route requirements without secrets: a scope, never a credential. */
  credentialScope: z.string().min(1),
  /** No default and no `.catch`. A spent permit that reads as an unused one
   *  silently buys a second billed attempt: `waiting` = a decision is
   *  outstanding, `authorized` = one unused permit, `started` = consumed. */
  substate: z.enum(['waiting', 'authorized', 'started']),
});
export type PendingRetry = z.infer<typeof PendingRetrySchema>;

/** The durable human retry permit: the one carrier of the gate the retry
 *  owner (`ModelInvoker`) walks through `waiting` -> `authorized` ->
 *  `started`; `null` retires it. */
export const ModelRetryPayloadSchema = z.strictObject({
  permit: PendingRetrySchema.nullable(),
});

/* ----------------------------------------------------------- run.snapshot */

/**
 * What the loop runs on, apart from where it stands: `run.position` is the
 * one record of the loop's position and coordinates, so a snapshot never
 * restates them and is written only when one of these, or the loop state
 * beside them, changes.
 */
const SnapshotRuntimeSchema = z.strictObject({
  modelId: z.string().min(1),
  backend: ModelBackendSchema,
  /**
   * Runtime-owned failure vocabulary, already persisted today and already
   * carrying the exhaustion classification that drives retry and route-switch
   * policy. Deliberately NOT derived from the package's `ModelError` (D3).
   */
  lastError: RetryErrorInfoSchema.nullable(),
  /**
   * Subscription routes this run must not bind again: one per retry the user
   * answered with their own API key, plus the launch's own seed. Durable so a
   * resume rebinds under the same choice; run-scoped so the user's stored
   * preference is never rewritten on their behalf.
   */
  declinedRoutes: z.array(DeclinableUsageRouteSchema).readonly(),
});
export type SnapshotRuntime = z.infer<typeof SnapshotRuntimeSchema>;

/** A snapshot restates nothing the rows carry (single-owner note, 3.3): the
 *  pending response, its intents and their approval bindings are folded from
 *  `model.message`, `tool.intent` and `tool.binding`. */
export const RunSnapshotPayloadSchema = z.strictObject({
  family: RunFamilySchema,
  runtime: SnapshotRuntimeSchema,
  state: ToolUseSnapshotStateSchema,
});
export type RunSnapshotPayload = z.infer<typeof RunSnapshotPayloadSchema>;
