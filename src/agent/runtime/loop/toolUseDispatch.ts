/**
 * Dispatch of one committed response's tool calls, from the folded state and
 * back into it. The guaranteed behaviours the node enforced, kept by
 * construction: contiguous parallel-safe calls run concurrently under a
 * small window while every other call is a barrier that runs alone and in
 * order; a call repeating an earlier call's name and arguments never executes
 * and derives its primary's result with no edits, attachments or mutation;
 * a result that ends the turn stops dispatch after its partition settles;
 * one interrupt cancels the whole in-flight batch through the fiber; and no
 * sibling failure interrupts another call, because a call never fails: its
 * error is its result.
 *
 * Write points: `tool.intent` before every barrier call; `tool.result` plus
 * its `tool.end` card per settled call, in one batch, with attachment bytes
 * captured before the batch commits; the delivering `append` with the
 * complete tool group once, when every call of the response has settled.
 *
 * Resume reads only row data: a settled call stays settled; a duplicate
 * derives its primary; a call an earlier `endTurn` skipped keeps its saved
 * skip; a barrier with an intent and no result is outcome-unknown and asks;
 * a parallel-safe call without a result re-runs.
 */
import { Cause, Effect, Exit, Result, SynchronizedRef } from 'effect';

import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { normalizeToolCallError } from '@agent/core/flows/toolCallParsing';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { ITool } from '@agent/core/tools/ToolTypes';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import { endToolUseCard, type AgentTrace } from '@agent/trace';
import {
  type DispatchFacts,
  type FileLocation,
  type RequestDecision,
  type StateOperation,
  type ToolCallStatus,
  type ToolFileAttachment,
  type ToolResult,
  type ToolResultPayload,
} from '@shared/schemas';
import { JsonValueSchema } from '@shared/schemas';
import { RunLedger, type RunLedgerRefused } from '@shared/session/runLedger';
import type { DatabaseWriteFailed } from '@shared/session/database';
import {
  foldRunState,
  type RunLedgerDraft,
  type RunState,
} from '@shared/session/runStateFold';
import { generateShortId, isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { pathToLocation } from '@utils/files/fileLocation';

import { AgentRun } from '../run/AgentRun';
import { inlineMediaPart, type InputPart } from '../run/mediaInput';
import { localCallsOf, parseCallArguments, type LocalCall } from '../run/tools';
import { formatToolResultTextWithAttachments } from '../run/toolResultText';
import {
  appendRow,
  displayRow,
  redactedForFact,
  rowAggregate,
  snapshotRow,
  stepRow,
  toolUseFlowState,
  type Message,
} from './rows';

/** Max concurrently executing tool calls within one parallel-safe partition. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** Maximum size of the streaming output buffer sent to the UI (bytes). */
const STREAM_BUFFER_MAX = 50_000;

const SKIPPED_AFTER_END_TURN =
  'Tool call skipped: an earlier tool call ended the turn.';
const SKIPPED_OUTCOME_UNKNOWN =
  'Tool call skipped: the run was interrupted after this call may have started, and its result was not recorded.';

type Settlement = Pick<
  ToolResultPayload,
  'disposition' | 'duplicateOf' | 'result' | 'attachments' | 'stateMutation'
>;

type SettledAttachment = ToolResultPayload['attachments'][number];
type InvokeError = RunLedgerRefused | DatabaseWriteFailed;

export interface TurnContext {
  readonly workspace: AgentWorkspaceState;
  readonly userInstruction: string | undefined;
}

interface DispatchOutcome {
  readonly state: RunState;
  /** A settled result asked to end the turn. */
  readonly endTurn: boolean;
}

/**
 * A sanitized result as the ledger stores it: `diagnostics` narrowed to JSON.
 * The sanitizer already reduced it to the validation-error shape or nothing,
 * so a value that is not JSON here is a defect in that projection, and the
 * row refuses it rather than storing a value `JSON.stringify` would throw on.
 */
function settledResult(result: ToolResult): Settlement['result'] {
  const { diagnostics, ...rest } = result;
  if (diagnostics === undefined) return rest;
  return { ...rest, diagnostics: JsonValueSchema.parse(diagnostics) };
}

const endsTurn = (settlement: Pick<Settlement, 'result'>): boolean =>
  settlement.result.status === 'executed' && settlement.result.endTurn === true;

/**
 * Attachment bytes captured as immutable content before the settlement
 * commits: from the tool's own payload when it carried one, from the path
 * otherwise; a capture failure records the omission and its reason.
 */
const captureAttachments = Effect.fn('toolUse.captureAttachments')(function* (
  attachments: readonly ToolFileAttachment[],
  inScope: <A>(operation: () => A) => A,
): Effect.fn.Return<readonly SettledAttachment[]> {
  const captured: SettledAttachment[] = [];
  for (const attachment of attachments) {
    const base = {
      path: attachment.path,
      mimeType: attachment.mimeType,
      ...(attachment.description !== undefined
        ? { description: attachment.description }
        : {}),
    };
    if (attachment.base64Data !== undefined && attachment.base64Data !== '') {
      captured.push({
        ...base,
        content: { kind: 'base64', data: attachment.base64Data },
      });
      continue;
    }
    if (attachment.bytes !== undefined && attachment.bytes.length > 0) {
      captured.push({
        ...base,
        content: {
          kind: 'base64',
          data: Buffer.from(attachment.bytes).toString('base64'),
        },
      });
      continue;
    }
    const read = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          AbsoluteFS.readBytes(
            inScope(() => pathToLocation(attachment.path)).absolutePath,
          ),
        catch: (cause) => cause,
      }),
    );
    captured.push(
      Exit.isSuccess(read)
        ? {
            ...base,
            content: { kind: 'base64', data: read.value.toString('base64') },
          }
        : {
            ...base,
            content: {
              kind: 'metadata-only',
              reason: toErrorMessage(Cause.squash(read.cause)),
            },
          },
    );
  }
  return captured;
});

/**
 * The model-visible content of one settlement: text, then inline media.
 *
 * An attachment the binding cannot carry inline (a PDF on a route without
 * native PDF support, an image on a text-only route, any other type) reaches
 * the model as the text mention only, and says so in the transcript rather
 * than degrading silently. Carrying those bytes by reference instead is
 * blocked on the package: `InputPartSchema` (`@llm/turn`) admits inline
 * base64 only and no `Model` exposes an upload, so the provider Files API
 * paths (`anthropicDocumentHandling`, `openAIResponseFileUploads`) have no
 * lowering to reach through and stay on the handlers that still call them.
 * The system design lists that gap as package work that gates the handler
 * retirement (2026-09-10-effect-native-runtime-system-design.md §5.4, slice 0).
 */
function settlementContent(
  settlement: Settlement,
  capabilities: Parameters<typeof inlineMediaPart>[2],
  logger: AgentTrace,
): readonly InputPart[] {
  const attachments: ToolFileAttachment[] = settlement.attachments.map(
    (attachment) => ({
      path: attachment.path,
      mimeType: attachment.mimeType,
      ...(attachment.description !== undefined
        ? { description: attachment.description }
        : {}),
    }),
  );
  const text = formatToolResultTextWithAttachments(
    settlement.result,
    attachments,
    true,
  );
  const media = settlement.attachments.flatMap((attachment) => {
    if (attachment.content.kind !== 'base64') {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: its bytes were not captured (${attachment.content.reason}).`,
      );
      return [];
    }
    const part = inlineMediaPart(
      attachment.mimeType,
      attachment.content.data,
      capabilities,
    );
    if (part === null) {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: the bound model carries no ${attachment.mimeType} attachment inline.`,
      );
      return [];
    }
    return [part];
  });
  return [{ kind: 'text', text }, ...media];
}

/** Dispatch every unsettled call of the pending response, then deliver. */
export const dispatchPendingResponse = Effect.fn('toolUse.dispatch')(function* (
  initial: RunState,
  turn: TurnContext,
): Effect.fn.Return<DispatchOutcome, InvokeError, AgentRun | RunLedger> {
  const run = yield* AgentRun;
  const ledger = yield* RunLedger;
  const { runId, logger } = run;
  const aggregateId = rowAggregate(runId);
  const pending = initial.pendingResponse;
  if (pending === null) return { state: initial, endTurn: false };
  const { responseId } = pending;
  const calls = localCallsOf(pending.turn);
  const stateRef = yield* SynchronizedRef.make(initial);

  /** Append rows under the state's semaphore: concurrent settlements of one
   *  parallel partition serialize here and each folds onto the latest. Rows
   *  may be built from that latest state, so a settlement that carries the
   *  workspace it mutated records it in the order the batches commit. */
  const append = (
    rows:
      | readonly RunLedgerDraft[]
      | ((state: RunState) => readonly RunLedgerDraft[]),
  ) =>
    SynchronizedRef.updateEffect(stateRef, (state) =>
      Effect.uninterruptible(
        ledger.appendBatch(
          runId,
          state,
          typeof rows === 'function' ? rows(state) : rows,
        ),
      ),
    );
  const settledOf = (state: RunState, callId: string) =>
    state.pendingResponse?.responseId === responseId
      ? (state.pendingResponse.settled[callId] ?? null)
      : null;

  /**
   * The workspace the call mutated, as the settlement's own operation. The
   * recorded edits, the media it added, the tool-call count and the work plan
   * are in-memory state until a snapshot carries them, and the delivering
   * snapshot lands only after every call of the response has settled: without
   * this a process exit between a `tool.result` and that delivery leaves a
   * call the resume will not run again whose effects on the run are gone.
   */
  const workspaceMutation = (state: RunState): readonly StateOperation[] => {
    const flow = toolUseFlowState(state);
    if (flow === null || flow.stateSlices === null) return [];
    return [
      {
        op: 'set',
        path: ['state', 'stateSlices', 'workspaceSnapshot'],
        value: turn.workspace.toSnapshot({ excludeAssemblyStrings: true }),
      },
    ];
  };

  const settle = (
    fact: DispatchFacts,
    attempt: number,
    settlement: Settlement,
    cards: readonly RunLedgerDraft[],
    /** An executed call carries the workspace with its result. A synthetic
     *  settlement ran no tool, and a duplicate reapplies no effect — the
     *  payload schema refuses one that claims otherwise. */
    ranTool = false,
  ) =>
    append((state) => [
      {
        type: 'tool.result',
        aggregateId,
        payload: {
          responseId,
          callId: fact.callId,
          attempt,
          ...settlement,
          ...(ranTool
            ? {
                stateMutation: [
                  ...settlement.stateMutation,
                  ...workspaceMutation(state),
                ],
              }
            : {}),
        },
      },
      ...cards,
    ]);

  const syntheticSettlement = (error: string): Settlement => ({
    disposition: 'skipped',
    duplicateOf: null,
    result: { status: 'error', error },
    attachments: [],
    stateMutation: [],
  });

  /** Execute one call and commit its settlement. Never fails: a throwing
   *  tool is an error result. Interruption leaves no settlement. */
  const execute = Effect.fn('toolUse.executeCall')(function* (
    fact: DispatchFacts,
    call: LocalCall,
    attempt: number,
  ): Effect.fn.Return<void, never> {
    const tool: ITool | undefined = run.tools.get(fact.toolName);
    const parsedInput = parseCallArguments(call, logger);
    const stageId = fact.stageId ?? undefined;
    const isDeferred = tool?.deferLogUntilApproval === true;
    let logId = fact.logId;
    if (logId !== null) {
      logger.toolStart(
        { logId, toolName: fact.toolName, input: parsedInput },
        { stageId },
      );
    }
    const onRunReady = isDeferred
      ? () => {
          if (logId === null) {
            logId = generateShortId();
            logger.toolStart(
              { logId, toolName: fact.toolName, input: parsedInput },
              { stageId },
            );
          }
        }
      : undefined;
    let onToolOutput: ((chunk: string) => void) | undefined;
    if (tool?.streamsOutput === true) {
      let outputBuffer = '';
      onToolOutput = (chunk: string) => {
        outputBuffer += chunk;
        if (outputBuffer.length > STREAM_BUFFER_MAX) {
          outputBuffer = outputBuffer.slice(-STREAM_BUFFER_MAX);
        }
        if (logId === null) return;
        endToolUseCard(
          logger,
          { logId, groupId: stageId },
          { toolName: fact.toolName, input: parsedInput, output: outputBuffer },
          'in_progress',
        );
      };
    }
    let subagentCost = 0;
    turn.workspace.interactions.recordToolCall();
    let result: ToolResult;
    if (!tool) {
      result = { status: 'error', error: `Unknown tool ${fact.toolName}` };
    } else {
      const invoked = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            // This call's stop, bridged from the fiber: the scope aborts it
            // when the call is interrupted. It reaches the tool as an
            // argument as well as through the call context, because a tool
            // that runs an Effect program of its own starts a root fiber
            // this one does not own, and the signal is what reaches that
            // root's waits.
            const signal = yield* Effect.abortSignal;
            return yield* Effect.tryPromise({
              try: () =>
                run.inScope(() =>
                  withToolFileInteractionContext(
                    {
                      tracker: turn.workspace.interactions,
                      workPlanState: turn.workspace.workPlan,
                      trace: logger,
                      userInstruction:
                        run.config.rootUserInstruction ?? turn.userInstruction,
                      toolCallId: fact.callId,
                      signal,
                      hooks: {
                        onRunReady,
                        onToolOutput,
                        // Subagent cost lands in the parent's totals only, so
                        // per-round usage reporting never double-counts it.
                        recordSubagentCost: (costUsd) => {
                          if (costUsd > 0) subagentCost += costUsd;
                        },
                      },
                    },
                    () => tool.call(parsedInput, signal),
                  ),
                ),
              catch: (cause) => cause,
            });
          }),
        ),
      );
      if (Exit.isSuccess(invoked)) {
        result = invoked.value;
      } else if (Cause.hasInterrupts(invoked.cause)) {
        return yield* Effect.interrupt;
      } else {
        const { message, diagnostics } = normalizeToolCallError(
          fact.toolName,
          Cause.squash(invoked.cause),
        );
        result = {
          status: 'error',
          error: message.trim() || 'Tool run failed.',
          ...(diagnostics ? { diagnostics } : {}),
        };
      }
    }
    // A result the schema refuses becomes an error result the model can read;
    // the projection of an error result cannot itself fail.
    const extracted = yield* Effect.try({
      try: () => extractToolAttachments(result),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          result = {
            status: 'error',
            error: `${fact.toolName}: Tool returned an invalid result (${toErrorMessage(error)})`,
          };
          return extractToolAttachments(result);
        }),
      ),
    );
    const trackedEdits = turn.workspace.interactions.recordEdits(
      result.status === 'executed' ? result.edits : undefined,
    );
    const editedFiles = trackedEdits.map((path) => ({
      path,
      ok: true,
      source: 'tool',
      sourceDisplay: 'Tool use',
    }));
    // Media a tool produced joins the workspace's media set when it exists.
    if (result.status === 'executed' && result.files?.length) {
      const validLocations: FileLocation[] = [];
      for (const attachment of result.files) {
        if (!isNonEmptyString(attachment.path)) continue;
        const location = run.inScope(() => pathToLocation(attachment.path));
        const exists = yield* Effect.tryPromise({
          try: () => AbsoluteFS.exists(location.absolutePath),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              logger.debug(
                `Skipping inaccessible media file: ${attachment.path}`,
                { data: cause },
              );
              return false;
            }),
          ),
        );
        if (exists) validLocations.push(location);
      }
      if (validLocations.length) {
        turn.workspace.media.addMediaFiles(validLocations);
      }
    }
    const attachments = yield* captureAttachments(
      extracted.attachments,
      run.inScope,
    );
    const { status: _status, ...logOutputBase } = extracted.sanitizedResult;
    const logOutput = {
      ...logOutputBase,
      ...(editedFiles.length ? { editedFiles } : {}),
    };
    const toolUseLog = {
      toolName: fact.toolName,
      input: parsedInput,
      ...(Object.keys(logOutput).length > 0 ? { output: logOutput } : {}),
      ...(editedFiles.length > 0 ? { files: editedFiles } : {}),
    };
    const status: ToolCallStatus =
      extracted.sanitizedResult.status === 'error' ? 'failed' : 'completed';
    // The whole card commits with the settlement: a slow tool's card is
    // already open and only closes here, and a fast tool's opens and closes
    // in this same batch under a log id minted for it. Publishing a terminal
    // card outside the batch would tell the transcript the call completed
    // while recovery still sees an unsettled call.
    const cardId = logId ?? generateShortId();
    const stage = stageId !== undefined ? { stageId } : {};
    const cards: RunLedgerDraft[] = [
      ...(logId === null
        ? [
            displayRow(runId, {
              type: 'tool.start',
              logId: cardId,
              toolName: fact.toolName,
              input: parsedInput,
              ...stage,
            }),
          ]
        : []),
      displayRow(runId, {
        type: 'tool.end',
        logId: cardId,
        status,
        result: toolUseLog,
        ...stage,
      }),
    ];
    yield* settle(
      fact,
      attempt,
      {
        disposition:
          extracted.sanitizedResult.status === 'executed'
            ? 'executed'
            : 'failed',
        duplicateOf: null,
        result: settledResult(extracted.sanitizedResult),
        attachments,
        stateMutation:
          subagentCost > 0
            ? [
                {
                  op: 'add',
                  path: ['usage', 'totalCost'],
                  amount: subagentCost,
                },
              ]
            : [],
      },
      cards,
      true,
    ).pipe(
      // A ledger refusal mid-dispatch is the loop's to stop on; it surfaces
      // as a defect of this call's fiber so the partition unwinds with it.
      Effect.orDie,
    );
  });

  /** Ask whether an outcome-unknown barrier re-runs or is skipped (A3). */
  const decideOutcomeUnknown = Effect.fn('toolUse.outcomeUnknown')(function* (
    fact: DispatchFacts,
    call: LocalCall,
    intent: {
      readonly attempt: number;
      readonly approvalRequestId: string | null;
    },
  ): Effect.fn.Return<'rerun' | 'skip', never> {
    let current = yield* SynchronizedRef.get(stateRef);
    const question = `The tool "${fact.toolName}" may have run before the run was interrupted, and no result was recorded. Run it again, or skip it?`;
    const rerunOption = 'Run again';
    // Only a person decides this barrier: the answer's chosen option, or a
    // `skip` (the host's own word for a person declining to answer), both
    // land as the request's `request.decided` (R5). A refusal with any
    // other provenance (a cancellation, a policy denial) was written by a
    // cleanup, not by a person, so it decides nothing and the barrier is
    // asked again.
    const decided = (decision: RequestDecision): 'rerun' | 'skip' | null => {
      if (decision.action === 'submit') {
        return decision.answers[question] === rerunOption ? 'rerun' : 'skip';
      }
      if (decision.action === 'skip') return 'skip';
      return null;
    };
    const bound = current.requests[intent.approvalRequestId ?? ''];
    if (bound !== undefined && bound.resolved && bound.decision !== null) {
      const answer = decided(bound.decision);
      if (answer !== null)
        return yield* recordOutcomeDecision(fact, intent, answer);
    }
    // A request the run committed and nobody answered is asked again under
    // its own id, so one barrier never accumulates requests. Anything else
    // opens a fresh one: the fold refuses a second `request.opened` on an id
    // it already carries, so a request retired without a decision cannot be
    // reopened, only replaced (and the snapshot below rebinds the intent).
    const standing =
      intent.approvalRequestId !== null &&
      bound !== undefined &&
      !bound.resolved
        ? intent.approvalRequestId
        : null;
    const requestId = standing ?? `tool-outcome-${generateShortId()}`;
    const request = {
      requestId,
      allowBypass: false,
      runId,
      questions: [
        {
          question,
          header: 'Tool',
          options: [
            { label: rerunOption, description: 'Execute the call once more.' },
            {
              label: 'Skip',
              description: 'Report it to the model as skipped.',
            },
          ],
        },
      ],
      context: call.argumentsText,
    };
    // A request row is committed whenever no live request stands: the call
    // never raised one, or the one it raised was retired without a decision
    // and this opens its replacement, bound to the same call by the snapshot.
    if (standing === null) {
      const flow = toolUseFlowState(current);
      if (flow === null) {
        return yield* Effect.die(
          new Error('A pending call needs an opened run.'),
        );
      }
      yield* append([
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          // The one redaction door every durable request payload passes,
          // whether the session opens the request or the loop commits it.
          payload: redactedForFact({ kind: 'userQuestion', data: request }),
          thread: null,
        },
        snapshotRow(runId, current, {
          phase: 'tools.dispatching',
          state: flow,
          intentBindings: { [fact.callId]: requestId },
        }),
      ]).pipe(Effect.orDie);
      current = yield* SynchronizedRef.get(stateRef);
    }
    // The decision is the `request.decided` row the decide command lands on
    // the tail. A plane that closes first, and every refusal a person did not
    // make, leave the `tool.intent` bound and the request open, and the
    // dispatch interrupts so the next resume asks the same question again.
    // Writing `skip` for a cancellation would tell the model a person skipped
    // the call.
    const row = yield* run.session
      .decisionFor(runId, requestId, current.commit)
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.warn(
              'The tool-outcome prompt closed; the call stays outcome-unknown and the next resume asks again.',
              { data: error },
            );
            return null;
          }),
        ),
      );
    if (row === null) return yield* Effect.interrupt;
    yield* SynchronizedRef.update(stateRef, (state) => {
      const folded = foldRunState(state, [row]);
      if (Result.isFailure(folded) || folded.success === null) {
        throw new Error(
          `The tool-outcome decision does not fold onto the run: ${
            Result.isFailure(folded) ? folded.failure.detail : 'no state'
          }`,
        );
      }
      return folded.success;
    });
    const answer = decided(row.decision);
    if (answer === null) return yield* Effect.interrupt;
    return yield* recordOutcomeDecision(fact, intent, answer);
  });

  /** A rerun admits a new attempt with its `tool.intent`; a skip records nothing further, the decision row is the fact. */
  const recordOutcomeDecision = Effect.fn('toolUse.outcomeDecision')(function* (
    fact: DispatchFacts,
    intent: { readonly attempt: number },
    decision: 'rerun' | 'skip',
  ): Effect.fn.Return<'rerun' | 'skip', never> {
    if (decision === 'rerun') {
      yield* append([
        {
          type: 'tool.intent',
          aggregateId,
          payload: {
            responseId,
            callIds: [fact.callId],
            attempt: intent.attempt + 1,
          },
        },
      ]).pipe(Effect.orDie);
    }
    return decision;
  });

  /** One call of a partition: the resume rules, then execution. */
  const dispatchCall = Effect.fn('toolUse.dispatchCall')(function* (
    fact: DispatchFacts,
    afterEndTurn: boolean,
  ): Effect.fn.Return<void, never> {
    const current = yield* SynchronizedRef.get(stateRef);
    if (settledOf(current, fact.callId) !== null) return;
    const call = calls[fact.ordinal];
    if (call === undefined) {
      return yield* Effect.die(new Error(`No call at ordinal ${fact.ordinal}`));
    }
    if (afterEndTurn) {
      yield* settle(
        fact,
        1,
        syntheticSettlement(SKIPPED_AFTER_END_TURN),
        [],
      ).pipe(Effect.orDie);
      return;
    }
    if (fact.parallelSafe) {
      yield* execute(fact, call, 1);
      return;
    }
    const intent = current.pendingIntents[fact.callId];
    if (intent !== undefined) {
      const decision = yield* decideOutcomeUnknown(fact, call, intent);
      if (decision === 'skip') {
        yield* settle(
          fact,
          intent.attempt,
          syntheticSettlement(SKIPPED_OUTCOME_UNKNOWN),
          [],
        ).pipe(Effect.orDie);
        return;
      }
      yield* execute(fact, call, intent.attempt + 1);
      return;
    }
    // The intent precedes every barrier call, unconditionally.
    yield* append([
      {
        type: 'tool.intent',
        aggregateId,
        payload: { responseId, callIds: [fact.callId], attempt: 1 },
      },
    ]).pipe(Effect.orDie);
    yield* execute(fact, call, 1);
  });

  /** A duplicate derives its primary's settlement, effects stripped. */
  const deriveDuplicate = Effect.fn('toolUse.duplicate')(function* (
    fact: DispatchFacts,
    primaryId: string,
  ): Effect.fn.Return<void, never> {
    const current = yield* SynchronizedRef.get(stateRef);
    if (settledOf(current, fact.callId) !== null) return;
    const primary = settledOf(current, primaryId);
    if (primary === null) {
      // The primary was interrupted or never ran; the duplicate waits with it.
      return;
    }
    const result: Settlement['result'] =
      primary.result.status === 'executed'
        ? (() => {
            const { edits: _edits, files: _files, ...shared } = primary.result;
            return shared;
          })()
        : primary.result;
    yield* settle(
      fact,
      1,
      {
        disposition: 'duplicate',
        duplicateOf: primaryId,
        result,
        attachments: [],
        stateMutation: [],
      },
      [],
    ).pipe(Effect.orDie);
  });

  // Partitions in order; each barrier is its own, each run of parallel-safe
  // calls shares one and executes under the window.
  const partitions = new Map<number, DispatchFacts[]>();
  for (const fact of pending.calls) {
    const members = partitions.get(fact.partition) ?? [];
    members.push(fact);
    partitions.set(fact.partition, members);
  }
  let endTurn = Object.values(pending.settled).some(endsTurn);
  for (const members of partitions.values()) {
    const primaries = members.filter((fact) => fact.duplicateOf === null);
    const duplicates = members.filter((fact) => fact.duplicateOf !== null);
    yield* Effect.forEach(primaries, (fact) => dispatchCall(fact, endTurn), {
      concurrency: MAX_PARALLEL_TOOL_CALLS,
      discard: true,
    });
    for (const fact of duplicates) {
      if (fact.duplicateOf !== null) {
        yield* deriveDuplicate(fact, fact.duplicateOf);
      }
    }
    const after = yield* SynchronizedRef.get(stateRef);
    if (!endTurn) {
      endTurn = members.some((fact) => {
        const settled = settledOf(after, fact.callId);
        return settled !== null && endsTurn(settled);
      });
    }
  }

  // Delivery: the paid turn enters history once, with the complete group.
  const settledState = yield* SynchronizedRef.get(stateRef);
  const settledPending = settledState.pendingResponse;
  if (settledPending === null || settledPending.responseId !== responseId) {
    return yield* Effect.die(
      new Error('The pending response changed during dispatch.'),
    );
  }
  const bound = yield* SynchronizedRef.get(run.model);
  const results = settledPending.calls.map((fact, ordinal) => {
    const settlement = settledPending.settled[fact.callId];
    if (settlement === undefined) {
      throw new Error(`Call ${fact.callId} is unsettled at delivery.`);
    }
    return {
      callOrdinal: ordinal,
      status:
        settlement.result.status === 'executed'
          ? ('success' as const)
          : ('error' as const),
      content: settlementContent(
        { ...settlement, stateMutation: [] },
        bound,
        logger,
      ),
    };
  });
  const group: Message = { role: 'tool', results };
  const flow = toolUseFlowState(settledState);
  if (flow === null) {
    return yield* Effect.die(new Error('Delivery needs an opened run.'));
  }
  // The snapshot's references describe the state after the delivering
  // append folds: no pending response, no intents of it. A snapshot authored
  // from the pre-delivery state would fail the fold's stale-snapshot check.
  const afterDelivery: RunState = {
    ...settledState,
    pendingResponse: null,
    pendingIntents: Object.fromEntries(
      Object.entries(settledState.pendingIntents).filter(
        ([, intent]) => intent.responseId !== responseId,
      ),
    ),
  };
  const delivered = yield* ledger.appendBatch(runId, settledState, [
    appendRow(runId, [group], responseId),
    snapshotRow(runId, afterDelivery, {
      phase: 'results.ready',
      state: {
        ...flow,
        stateSlices:
          flow.stateSlices === null
            ? null
            : {
                ...flow.stateSlices,
                workspaceSnapshot: turn.workspace.toSnapshot({
                  excludeAssemblyStrings: true,
                }),
              },
      },
    }),
    stepRow(runId, settledState, 'results.ready'),
  ]);
  return { state: delivered, endTurn };
});
