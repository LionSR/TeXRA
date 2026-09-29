/**
 * Payloads for the run-ledger arms of `SessionEventDraftSchema`
 * (`2026-09-08-pr1-run-ledger-foundation.md` section 2). Shapes only: the
 * arms themselves live in `sessionEvent.ts`, which is the single vocabulary
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

import {
  CancellationEvidenceSchema,
  ContinuationSchema,
  MessageSchema,
  ModelOriginSchema,
  RemoteOperationSchema,
  TurnResultSchema,
} from '@texra-ai/llm/turn';

import { RetryErrorInfoSchema } from './errors';
import { JsonValueSchema } from './jsonValue';
import { Sha256Schema } from './offeredTools';
import { RunOutcomeSchema } from './run';
import {
  ModelCompatibilityKeySchema,
  NormalizedUsageSchema,
  ToolUseSnapshotStateSchema,
} from './runSnapshotState';
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
  /** Contiguous dispatch partition; each barrier is its own. */
  partition: z.int().nonnegative(),
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
    /**
     * A billed request is about to leave the process. Carries no history,
     * only the address of the rest it sends (`requestContext.ts`).
     */
    z.strictObject({
      kind: z.literal('attempt'),
      invocation: InvocationRefSchema,
      request: Sha256Schema,
      origin: ModelOriginSchema,
      delivery: z.enum(['stream', 'blocking', 'background']),
    }),
    /** Provider identity observed before completion. */
    z.strictObject({
      kind: z.literal('identified'),
      invocation: InvocationRefSchema,
      providerResponseId: z.string().min(1),
      returnedModel: z.string().min(1).nullable(),
    }),
    /**
     * The commit barrier: the accepted remote operation, committed before
     * `observe` is called. `deadlineAtMs` is the limit admitted with the
     * submission, never one recomputed from current settings; the package
     * produces neither it nor an attempt, so both ride the envelope (D2).
     */
    z.strictObject({
      kind: z.literal('accepted'),
      invocation: InvocationRefSchema,
      operation: RemoteOperationSchema,
      deadlineAtMs: z.int().positive(),
    }),
    /**
     * A user stop cancelled the accepted operation; `evidence` is the
     * provider's reply verbatim. It retires the operation, so a resume starts
     * a new attempt instead of observing work the user stopped. A cancel that
     * failed leaves no row, and the still-live operation stays observable.
     */
    z.strictObject({
      kind: z.literal('cancelled'),
      invocation: InvocationRefSchema,
      evidence: CancellationEvidenceSchema,
    }),
    /**
     * A completed provider turn, committed once and reused after restart.
     * `turn` is `TurnResultSchema` verbatim: ordered content with its exact
     * signatures and encrypted reasoning, the complete call list, finish
     * reason and native finish evidence, observed usage, continuation.
     */
    z.strictObject({
      kind: z.literal('response'),
      responseId: ResponseIdSchema,
      invocation: InvocationRefSchema,
      turn: TurnResultSchema,
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
      messages: z.array(MessageSchema).min(1).readonly(),
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

/* ------------------------------------------------------- model.compaction */

/**
 * The only row that shortens history; `usage` is its summary call's priced
 * usage, folded as a response's (`null`: a switch calls no model). `keepPrefix`
 * spares a compaction that keeps the head (a switch keeps all of it) storing
 * the conversation again. Whether the result is preparable is the ledger's
 * check (D11), at write and cold load: a payload cannot see its prefix.
 */
export const ModelCompactionPayloadSchema = z.strictObject({
  keepPrefix: z.int().nonnegative(),
  messages: z.array(MessageSchema).readonly(),
  cause: z.enum(['context-limit', 'context-window', 'model-switch']),
  continuation: ContinuationSchema.nullable(),
  usage: NormalizedUsageSchema.nullable(),
});

/* ------------------------------------------------------------ tool.intent */

export const ToolIntentPayloadSchema = z.strictObject({
  responseId: ResponseIdSchema,
  callIds: z.array(CallIdSchema).min(1).readonly(),
  /** Increases only after a re-run decision: a person's, or the replay rule
   *  for a call whose saved and current declarations both say `safe`. An
   *  earlier approval never authorizes another attempt implicitly. */
  attempt: z.int().positive(),
});

/* ----------------------------------------------------------- tool.binding */

/** The approval that guards one outcome-unknown call: the single carrier of
 *  an intent's `approvalRequestId`, committed beside the `request.opened` it
 *  names. `attempt` is the intent attempt the approval admits, so a later
 *  dispatch of the same call needs its own binding. */
export const ToolBindingPayloadSchema = z.strictObject({
  callId: CallIdSchema,
  attempt: z.int().positive(),
  requestId: z.string().min(1),
});

/* ------------------------------------------------------------ tool.result */

/**
 * Per-call state operations over the run's mutable `state` slice, never a
 * whole-state copy that could overwrite a concurrent call. Folding a result
 * applies its mutation exactly once. The run's `usage` is not a slice a call
 * can touch: it is derived from the priced usage of the run's own response
 * rows (D12) and nothing else, so a child's spend stays on the child's run and
 * a parent's or session's total is the sum over the run tree.
 */
const StateOperationSchema = z.strictObject({
  op: z.literal('set'),
  path: z
    .array(z.string().min(1))
    .min(1)
    .refine(
      (path) => path[0] === 'state',
      'A tool result sets only the run state slice; the usage totals are derived.',
    ),
  value: JsonValueSchema,
});
export type StateOperation = z.infer<typeof StateOperationSchema>;

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
    stateMutation: z.array(StateOperationSchema).readonly(),
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
    if (
      p.disposition === 'duplicate' &&
      (p.attachments.length > 0 || p.stateMutation.length > 0)
    ) {
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
  failedCompatibilityKey: ModelCompatibilityKeySchema.nullable(),
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
  modelCompatibilityKey: ModelCompatibilityKeySchema.nullable(),
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
