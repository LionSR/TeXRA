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
  ContinuationSchema,
  MessageSchema,
  ModelOriginSchema,
  RemoteOperationSchema,
  TurnResultSchema,
} from '@llm/turn';

import { RetryErrorInfoSchema } from './errors';
import { JsonValueSchema } from './jsonValue';
import { RunOutcomeSchema } from './run';
import {
  AgentRunStateSnapshotSchema,
  ModelCompatibilityKeySchema,
  NormalizedUsageSchema,
  ReflectionSnapshotStateSchema,
  StateSlicesSchema,
  ToolUseSnapshotStateSchema,
} from './runFlowState';
import {
  ErrorToolResultSchema,
  ExecutedToolResultSchema,
  ToolFileAttachmentSchema,
} from './toolResult';
import { DeclinableUsageRouteSchema } from './usage';

/* ------------------------------------------------------------------ ids */

const RunFamilySchema = z.enum(['toolUse', 'reflection']);
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

/* ------------------------------------------------------------- flow.step */

const FlowStepSchema = z.enum([
  'round.begin',
  'round.end',
  'turn.ready',
  'turn.begin',
  'turn.end',
  'response.ready',
  'response.processed',
  'results.ready',
  'output.ready',
  'waiting',
  'halted',
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;

/** The loop's coordinates: the step and where it sits. What `RunView.flow`
 *  carries, so a renderer paints the position without the halt's outcome. */
export const RunFlowSchema = z.strictObject({
  family: RunFamilySchema,
  step: FlowStepSchema,
  round: z.int().nonnegative().nullish(),
  turn: z.int().nonnegative().nullish(),
  /** Reflection's within-round response-cycle index. Not `continuation`:
   *  the package's `Continuation` anchor lives in the same `RunState`, and
   *  two fields one word apart is a live foot-gun. */
  continuationIndex: z.int().nonnegative().nullish(),
});
export type RunFlow = z.infer<typeof RunFlowSchema>;

export const FlowStepPayloadSchema = RunFlowSchema.extend({
  /** The loop's own terminal word. The canonical terminal fact stays
   *  `run.end`, which also covers failures before the runtime starts. */
  outcome: RunOutcomeSchema.nullish(),
}).refine(
  (p) => (p.step === 'halted') === (p.outcome != null),
  'Only a halted step carries an outcome, and it always carries one.',
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
     * A billed request is about to leave the process. Carries no history:
     * the history is whatever the rows below this commit say.
     */
    z.strictObject({
      kind: z.literal('attempt'),
      invocation: InvocationRefSchema,
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
     * Canonical messages appended to history, verbatim.
     *
     * When `sourceResponse` is set the row carries ONLY the settlement group
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
 * The only row that shortens history. `keepPrefix` exists so a reflection
 * round-open does not re-store the entire conversation, media inlined as
 * base64, once per round. Nothing here checks that the resulting history is
 * preparable: that check is the ledger's, at the write boundary and on cold
 * load (D11), because a payload cannot see the prefix it keeps.
 */
export const ModelCompactionPayloadSchema = z
  .strictObject({
    keepPrefix: z.int().nonnegative(),
    messages: z.array(MessageSchema).readonly(),
    cause: z.enum([
      'handler-replacement',
      'round-open',
      'context-limit',
      'model-switch',
    ]),
    continuation: ContinuationSchema.nullable(),
    continuationDropped: z
      .enum(['history-replaced', 'protocol-has-no-continuation'])
      .nullable(),
  })
  .refine(
    (p) => p.continuation === null || p.continuationDropped === null,
    'A replaced continuation is not also a dropped one.',
  );

/* ------------------------------------------------------------ tool.intent */

export const ToolIntentPayloadSchema = z.strictObject({
  responseId: ResponseIdSchema,
  callIds: z.array(CallIdSchema).min(1).readonly(),
  /** Increases only after an explicit re-run decision. An earlier approval
   *  never authorizes another attempt implicitly. */
  attempt: z.int().positive(),
});

/* ------------------------------------------------------------ tool.result */

/** `ToolFileAttachment.bytes` is a `Uint8Array`, which JSON does not
 *  reconstruct; a path alone is not recoverable content; a capture failure
 *  records the omission and its reason rather than a claim that bytes were
 *  included. */
const SettledAttachmentSchema = z.strictObject({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  description: z.string().optional(),
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('base64'), data: z.base64() }),
    z.strictObject({
      kind: z.literal('metadata-only'),
      reason: z.string().min(1),
    }),
  ]),
});

/**
 * The follow-up builder's input. Derived from the exported members, never
 * re-declared: `files` loses its binary payload and `diagnostics` is narrowed
 * from `z.unknown()` to JSON, because an arbitrary value in a durable payload
 * is a `JSON.stringify` throw waiting for a cycle or a BigInt.
 *
 * `SettledFileSchema` is derived from `ToolFileAttachmentSchema`, NOT rebuilt
 * as a `strictObject`: its base `FileReferenceSchema` is a `z.looseObject`
 * and real attachments carry `base64Data`/`bytes` plus whatever extra keys a
 * tool attached, so a strict rebuild would refuse every executed result that
 * has an attachment. That same looseness is why the two binary fields go
 * through a transform rather than `.omit()`: on a loose object an omitted key
 * is only undeclared, so `base64Data` and the `Uint8Array` in `bytes` would
 * pass through as unknown keys and land in the row anyway. What the transform
 * leaves is then validated as JSON, exactly as `diagnostics` is: the loose
 * keys a tool attached are `unknown`, and a third byte buffer or a cyclic
 * object among them is the same `JSON.stringify` throw, on a row that is
 * already committed. The check runs after the transform rather than as a
 * `.pipe`, so the accepted input stays the real attachment a tool produced.
 */
const SettledFileMetadataSchema = ToolFileAttachmentSchema.omit({
  base64Data: true,
  bytes: true,
}).catchall(JsonValueSchema);
const SettledFileSchema = ToolFileAttachmentSchema.transform(
  ({ base64Data: _base64Data, bytes: _bytes, ...file }) => file,
).superRefine((file, ctx) => {
  const metadata = SettledFileMetadataSchema.safeParse(file);
  if (metadata.success) return;
  for (const issue of metadata.error.issues) ctx.addIssue({ ...issue });
});
const SettledToolResultSchema = z.discriminatedUnion('status', [
  ExecutedToolResultSchema.omit({ files: true }).extend({
    files: z.array(SettledFileSchema).optional(),
    diagnostics: JsonValueSchema.optional(),
  }),
  ErrorToolResultSchema.extend({ diagnostics: JsonValueSchema.optional() }),
]);

/**
 * Per-call state operations over the run's mutable slices, never a whole-state
 * copy that could overwrite a concurrent call. `add` is not optional
 * generality: `recordSubagentCost` adds raw USD into the run's usage totals
 * from inside a tool call, and an enumerated slice list cannot express it.
 * Folding a result applies its mutation exactly once.
 *
 * Under `usage`, `add` is the ONLY operation. The run's accounting is derived
 * from the priced usage of every response row plus additive tool costs (D12);
 * a `set` rewriting `totalCost`, an `append`, or a `delete` whose total the
 * next parse prefaults back to zero would each make a resumed run's cost a
 * number no row accounts for, and `applyMutations` cannot tell the difference
 * because the rewritten totals still parse.
 */
const StateOperationSchema = z
  .discriminatedUnion('op', [
    z.strictObject({
      op: z.literal('set'),
      path: z.array(z.string().min(1)).min(1),
      value: JsonValueSchema,
    }),
    z.strictObject({
      op: z.literal('delete'),
      path: z.array(z.string().min(1)).min(1),
    }),
    z.strictObject({
      op: z.literal('append'),
      path: z.array(z.string().min(1)).min(1),
      items: z.array(JsonValueSchema).min(1),
    }),
    z.strictObject({
      op: z.literal('add'),
      path: z.array(z.string().min(1)).min(1),
      amount: z.number().finite(),
    }),
  ])
  .refine(
    (op) => op.op === 'add' || op.path[0] !== 'usage',
    'The run usage totals are derived: a tool result only adds to them.',
  );
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

/* ----------------------------------------------------------- flow.snapshot */

/** The loop's own phase vocabulary: ten closed values, distinct from the
 *  five display phases of `RunPhaseSchema` (D9). */
const RunLoopPhaseSchema = z.enum([
  'initial',
  'round.ready',
  'model.ready',
  'model.submitted',
  'response.ready',
  'tools.dispatching',
  'results.ready',
  'output.pending',
  'waiting',
  'halted',
]);
export type RunLoopPhase = z.infer<typeof RunLoopPhaseSchema>;

const PendingRetrySchema = z.strictObject({
  requestId: z.string().min(1),
  invocation: InvocationRefSchema,
  failedModelId: z.string().min(1),
  failedCompatibilityKey: ModelCompatibilityKeySchema.nullable(),
  /** Route requirements without secrets: a credential scope, never a
   *  credential. */
  credentialScope: z.string().min(1),
  /**
   * No default and no `.catch`. A spent permit that reads as an unused one
   * silently buys a second billed attempt: `waiting` = a decision is
   * outstanding, `authorized` = exactly one unused permit, `started` =
   * consumed, a new decision is required.
   */
  substate: z.enum(['waiting', 'authorized', 'started']),
});

/** Reference fields the fold reconciles rather than replaces. */
const SnapshotReferencesSchema = z.strictObject({
  pendingIntents: z
    .array(
      z.strictObject({
        callId: CallIdSchema,
        attempt: z.int().positive(),
        responseId: ResponseIdSchema,
        approvalRequestId: z.string().min(1).nullable(),
      }),
    )
    .readonly(),
  pendingResponse: z
    .strictObject({
      responseId: ResponseIdSchema,
      settled: z.array(CallIdSchema).readonly(),
    })
    .nullable(),
});

/** Coordinates and runtime-owned failure state, which no row carries. */
const SnapshotRuntimeSchema = z.strictObject({
  phase: RunLoopPhaseSchema,
  round: z.int().nonnegative(),
  turn: z.int().nonnegative(),
  continuationIndex: z.int().nonnegative(),
  modelId: z.string().min(1),
  modelCompatibilityKey: ModelCompatibilityKeySchema.nullable(),
  /**
   * Runtime-owned failure vocabulary, already persisted today and already
   * carrying the exhaustion classification that drives retry and route-switch
   * policy. Deliberately NOT derived from the package's `ModelError` (D3).
   */
  lastError: RetryErrorInfoSchema.nullable(),
  pendingRetry: PendingRetrySchema.nullable(),
  /**
   * Subscription routes this run must not bind again: one per retry the user
   * answered with their own API key, plus the launch's own seed. Durable so a
   * resume rebinds under the same choice; run-scoped so the user's stored
   * preference is never rewritten on their behalf.
   */
  declinedRoutes: z.array(DeclinableUsageRouteSchema).readonly(),
});
export type SnapshotRuntime = z.infer<typeof SnapshotRuntimeSchema>;

/**
 * The usage accumulator is NOT a snapshot field (D12): the fold derives usage
 * from `model.message response` and `tool.result` `add` ops, which is what
 * makes the restore-only rule sound. `.omit` here, not in `runFlowState.ts`,
 * so the relocation stays behaviour-identical for the agent modules.
 */
const LedgerRunStateSnapshotSchema = AgentRunStateSnapshotSchema.omit({
  usageAccumulator: true,
});

const SnapshotArmFields = {
  runtime: SnapshotRuntimeSchema,
  references: SnapshotReferencesSchema,
};

export const FlowSnapshotPayloadSchema = z.discriminatedUnion('family', [
  z.strictObject({
    family: z.literal('toolUse'),
    ...SnapshotArmFields,
    /** The non-message fields of `ToolUseRunSharedSchema`. */
    state: ToolUseSnapshotStateSchema.extend({
      stateSlices: StateSlicesSchema.extend({
        runStateSnapshot: LedgerRunStateSnapshotSchema,
      }).nullable(),
    }),
  }),
  z.strictObject({
    family: z.literal('reflection'),
    ...SnapshotArmFields,
    /** The non-message fields of `ReflectionFlowStateSchema`.
     *  `workspaceSnapshot` and `runStateSnapshot` stay top-level: reflection
     *  has no `stateSlices` and no `userChannels`. */
    state: ReflectionSnapshotStateSchema.extend({
      runStateSnapshot: LedgerRunStateSnapshotSchema,
    }),
  }),
]);
export type FlowSnapshotPayload = z.infer<typeof FlowSnapshotPayloadSchema>;
