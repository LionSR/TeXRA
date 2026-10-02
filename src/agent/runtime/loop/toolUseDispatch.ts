/**
 * Dispatch of one committed response's tool calls, from the folded state and
 * back into it. The guaranteed behaviours the node enforced, kept by
 * construction: contiguous parallel-safe calls run concurrently under a
 * small window while every other call is a barrier that runs alone and in
 * order; a call repeating an earlier call's name and arguments never executes
 * and derives its primary's result with no edits, attachments or mutation;
 * a result that ends the turn stops dispatch after its partition settles;
 * one interrupt cancels the whole in-flight batch through the fiber; and no
 * ordinary tool failures become model-visible results. Durable write failures
 * halt dispatch so an unsettled call is never recorded as successful.
 *
 * Write points: `tool.intent` before every call runs; `tool.result` plus
 * its `tool.end` card per settled call, in one batch, with attachment bytes
 * captured before the batch commits; the delivering `append` with the
 * complete tool group once, when every call of the response has settled.
 *
 * Resume reads only row data: a settled call stays settled; a duplicate
 * derives its primary; a call an earlier `endTurn` skipped keeps its saved
 * skip; an unfinished call re-runs when `replayable` says so, else asks; a
 * recovered call with no intent never started. The model decides on retries.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Ref,
  type Scope,
  Semaphore,
  SynchronizedRef,
} from 'effect';
import { z } from 'zod';

import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { normalizeToolCallError } from '@agent/core/tools/toolCallParsing';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import {
  ScriptDiverged,
  ToolCall,
  type CallRequests,
  type ScriptCalls,
  type ScriptScope,
  type ScriptSource,
} from '@agent/runtime/ToolCall';
import type { AgentTrace } from '@agent/trace';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  type DispatchFacts,
  type FileListEntry,
  type FileLocation,
  type JsonValue,
  type RequestDecision,
  type StateOperation,
  type ToolCallStatus,
  type ToolFileAttachment,
  type ToolIntentOrigin,
  type ToolResult,
  type ToolResultPayload,
} from '@shared/schemas';
import { JsonValueSchema, toJsonValue } from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runLedger';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import {
  type RunLedgerDraft,
  type RunState,
} from '@shared/session/runStateFold';
import { generateShortId, getBasename } from '@utils/core';
import { isNonEmptyString } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';
import { entryExists } from '@utils/files/fsEntryExists';

import { AgentRun } from '../run/AgentRun';
import { inlineMediaPart, type InputPart } from '../run/mediaInput';
import { stored } from '../run/requestContext';
import {
  localCallsOf,
  parseCallArguments,
  replayable,
  SKIPPED_NOT_STARTED,
  SKIPPED_OUTCOME_UNKNOWN,
} from '../run/tools';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../run/toolResultText';
import { policyDecidedRows } from '../requestPolicy';
import { guardedToolCall } from './toolGuard';
import { callHookText, preToolUse } from './hooks';
import {
  appendRow,
  bindingRow,
  displayRow,
  rowAggregate,
  snapshotRow,
  positionRow,
  type Message,
} from './rows';
import type { StepTools } from './step';
import type { JoinedFollowUps } from '../FollowUps';
import type { InvokeError } from '../ModelInvoker';
import type { Runs } from '../runRegistry';
import type { RunCell } from './runProgram';

/** Max concurrently executing tool calls within one parallel-safe partition. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** How much of a running tool's output streams to its card as transient
 *  text; the settlement carries the bounded capture whatever streamed. */
const STREAMED_OUTPUT_MAX = 50_000;

const SKIPPED_AFTER_END_TURN =
  'Tool call skipped: an earlier tool call ended the turn.';

/** What the per-call program needs of a call, whichever origin issued it:
 *  a response's dispatch fact, or a script's `script.call`. */
type CallFacts = Pick<
  DispatchFacts,
  'callId' | 'toolName' | 'replay' | 'logId' | 'stageId'
> & {
  /** A script's call: its guest's `phase()` title when it was issued. */
  readonly phase?: string | null;
};

type Settlement = Pick<
  ToolResultPayload,
  'disposition' | 'duplicateOf' | 'result' | 'attachments' | 'stateMutation'
>;

type SettledAttachment = ToolResultPayload['attachments'][number];

/** What a call may reach besides its arguments: the calls it may issue as
 *  a script, or the script that issued it. */
interface CallContext {
  readonly scriptCalls?: Effect.Effect<ScriptCalls>;
  readonly script?: ScriptScope;
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
  workspaceRoot: string | undefined,
): Effect.fn.Return<
  readonly SettledAttachment[],
  never,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
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
      fs.readFile(
        pathToLocationIn(workspaceRoot, attachment.path).absolutePath,
      ),
    );
    captured.push(
      Exit.isSuccess(read)
        ? {
            ...base,
            content: {
              kind: 'base64',
              data: Buffer.from(read.value).toString('base64'),
            },
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
 * How long delivery waits on the provider to take one upload. Uploading is
 * an optimisation for later rounds, so a stalled files endpoint must cost
 * delivery no more than this; the bytes are delivered either way.
 */
const UPLOAD_DEADLINE = '5 seconds';

/**
 * The model-visible content of one settlement: text, then inline media. The
 * ledger keeps the bytes; whether a later request sends them or a file id is
 * the bound model's in-memory upload cache's decision, made when it lowers.
 *
 * An attachment the binding cannot carry inline (a PDF on a route without
 * native PDF support, an image on a text-only route, any other type) reaches
 * the model as the text mention only, and says so in the transcript rather
 * than degrading silently.
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
  const text = formatToolResultAsText(
    settlement.result,
    attachments.length > 0 ? formatAttachmentSummary(attachments) : undefined,
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

/** Dispatch the pending response's unsettled calls under `step`'s tools,
 *  then deliver, with the `joined` rows and what they record. */
export const dispatchPendingResponse = Effect.fn('toolUse.dispatch')(function* (
  cell: RunCell,
  workspace: AgentWorkspaceState,
  step: StepTools,
  joined?: Pick<JoinedFollowUps, 'rows' | 'recorded'> | null,
): Effect.fn.Return<
  DispatchOutcome,
  InvokeError,
  AgentRun | ProcessServices | Runs | WorkspaceFs | StorageFs
> {
  const run = yield* AgentRun;
  const { runId, logger } = run;
  const aggregateId = rowAggregate(runId);
  const initial = yield* cell.current;
  const pending = initial.pendingResponse;
  if (pending === null) return { state: initial, endTurn: false };
  const { responseId } = pending;
  // Folded from stored rows, not received here: a call with no intent never ran.
  const recovered = cell.opened.pendingResponse?.responseId === responseId;
  const calls = localCallsOf(pending.turn);
  // The calls answer the instruction the committed state records.
  const at = initial.loop?.instruction;
  const userInstruction =
    run.config.rootUserInstruction ??
    (at ? stored(initial, at, z.string()) : run.config.instruction);
  // Concurrent settlements of one parallel partition serialize under the
  // cell's lock and each folds onto the latest state, so a settlement that
  // carries the workspace it mutated records it in the order batches commit.
  const { append } = cell;
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
    if (state.loop?.stateSlices == null) return [];
    return [
      {
        op: 'set',
        path: ['state', 'stateSlices', 'workspaceSnapshot'],
        value: workspace.toSnapshot(),
      },
    ];
  };

  const settle = (
    fact: CallFacts,
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

  /** The row that opens a call's card. A slow tool's is committed with the
   *  row that admits the attempt, so a resume finds the card its settlement
   *  closes; a fast tool's rides the settlement batch itself. */
  const cardStart = (
    fact: CallFacts,
    input: unknown,
    attempt: number,
  ): RunLedgerDraft =>
    displayRow(runId, {
      type: 'tool.start',
      logId: fact.logId,
      toolName: fact.toolName,
      input: toJsonValue(input),
      ...(fact.phase != null ? { phase: fact.phase } : {}),
      ...(attempt > 1 ? { attempt } : {}),
      ...(fact.stageId !== null ? { stageId: fact.stageId } : {}),
    });
  /** The card rows a settlement commits: a slow tool's card is open already
   *  and only closes, a fast tool's opens and closes in the same batch. The
   *  card stores no output: a read projects it from the `tool.result` the
   *  batch commits (`rowCodec.ts`). */
  const settledCards = (
    fact: CallFacts,
    input: unknown,
    status: ToolCallStatus,
    attempt: number,
    files: readonly FileListEntry[] = [],
  ): RunLedgerDraft[] => [
    ...(step.registry.get(fact.toolName)?.slow === true
      ? []
      : [cardStart(fact, input, attempt)]),
    displayRow(runId, {
      type: 'tool.end',
      logId: fact.logId,
      status,
      ...(files.length > 0 ? { files: [...files] } : {}),
      ...(fact.stageId !== null ? { stageId: fact.stageId } : {}),
    }),
  ];
  /** The card rows an admitted attempt opens: a slow tool's, before it runs. */
  const admittedCards = (
    fact: CallFacts,
    input: unknown,
    attempt: number,
  ): RunLedgerDraft[] =>
    step.registry.get(fact.toolName)?.slow === true
      ? [cardStart(fact, input, attempt)]
      : [];

  /** The row that admits an attempt of the calls an origin issued. */
  const intentRow = (
    origin: ToolIntentOrigin,
    callId: string,
    attempt: number,
  ): RunLedgerDraft => ({
    type: 'tool.intent',
    aggregateId,
    payload: { origin, callIds: [callId], attempt },
  });
  const fromResponse: ToolIntentOrigin = { kind: 'response', responseId };

  const syntheticSettlement = (error: string): Settlement => ({
    disposition: 'skipped',
    duplicateOf: null,
    result: { status: 'error', error },
    attachments: [],
    stateMutation: [],
  });

  /** Execute one call and commit its settlement. Never fails: a throwing
   *  tool is an error result. Interruption leaves no settlement. `standing`
   *  is the call's own request a resumed attempt re-enters: still open, or
   *  answered since this owner took the run and not yet read. */
  const execute = Effect.fn('toolUse.executeCall')(function* (
    fact: CallFacts,
    parsedInput: unknown,
    attempt: number,
    standing: {
      readonly requestId: string;
      readonly decision: RequestDecision | null;
    } | null = null,
    /** A call a response issued may issue calls of its own, as a script;
     *  a call a script issued knows that script. */
    context: CallContext = {},
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem
  > {
    const fs = yield* FileSystem.FileSystem;
    const tool: ITool | undefined = step.registry.get(fact.toolName);
    const stageId = fact.stageId ?? undefined;
    // A slow tool's card is open: `dispatchCall` committed its `tool.start`
    // with the row that admitted this attempt. What the tool prints while it
    // runs streams to that card as transient text, the way a response's
    // chunks reach a streaming row (C3): never a row of its own, capped, and
    // refused once the call has returned, so no chunk can be enqueued after
    // the settlement that closes the card.
    const cardOpen = tool?.slow === true;
    let accepting = cardOpen;
    let streamed = 0;
    const onToolOutput = (chunk: string): void => {
      if (!accepting) return;
      const text = chunk.slice(0, STREAMED_OUTPUT_MAX - streamed);
      if (text.length === 0) return;
      streamed += text.length;
      run.session.publishRunEvent(runId, {
        type: 'stream.chunk',
        id: fact.logId,
        text,
        ...(stageId !== undefined ? { stageId } : {}),
      });
    };
    // The call's requests. The first this attempt raises commits with the
    // `tool.binding` that ties it to the call, so a restart leaves it open
    // and the resume re-enters the call; a later one parks a body already
    // past its first answer, which nothing can re-enter, so it stays unbound
    // and a restart retires it. A resumed attempt re-enters the request it
    // left standing, under its own id; one it no longer raises is retired
    // as cancelled, so no surface keeps offering it.
    let reentering = standing;
    let bound = standing !== null;
    // Through the decision authority's own check, so an answer a surface
    // landed meanwhile stands and the retirement writes nothing.
    const retireStanding = Effect.suspend(() => {
      const open = reentering?.decision === null ? reentering : null;
      reentering = null;
      if (open === null) return Effect.void;
      return run.session
        .decideRequest(runId, open.requestId, {
          action: 'cancel',
          cause: 'The resumed call no longer asks it.',
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              logger.warn(
                `Request ${open.requestId} the resumed call no longer asks stays open: its retirement failed.`,
                { data: error },
              ),
            ),
          ),
          Effect.asVoid,
        );
    });
    const requests: CallRequests = {
      nextId: (prefix) =>
        reentering?.requestId.startsWith(`${prefix}-`) === true
          ? reentering.requestId
          : `${prefix}-${generateShortId()}`,
      open: (payload, options) =>
        Effect.suspend(() => {
          const reentered =
            payload.data.requestId === reentering?.requestId
              ? reentering
              : null;
          if (reentered !== null) reentering = null;
          const binds = !bound;
          bound = true;
          // Answered before this owner's loop reached the call: the answer
          // is the row's, and what the host staged for it is released here,
          // as no later decision will release it.
          if (reentered?.decision != null)
            return Effect.as(
              Effect.uninterruptible(options?.onNeverCommitted ?? Effect.void),
              reentered.decision,
            );
          return run.session.openRequest(runId, payload, {
            ...options,
            open: (rows) => {
              if (reentered !== null) {
                // Open already: only what the policy decides commits, and
                // the decision is read from where the resume read the run.
                const decided = rows.filter(
                  (row) => row.type !== 'request.opened',
                );
                const from = cell.opened.commit;
                return decided.length === 0
                  ? Effect.succeed(from)
                  : append(decided).pipe(Effect.as(from));
              }
              return retireStanding.pipe(
                Effect.andThen(Effect.sync(() => run.session.now())),
                Effect.flatMap((from) =>
                  append([
                    ...rows,
                    ...(binds
                      ? [
                          bindingRow(runId, {
                            callId: fact.callId,
                            attempt,
                            requestId: payload.data.requestId,
                            role: 'call',
                          }),
                        ]
                      : []),
                  ]).pipe(Effect.as(from)),
                ),
              );
            },
          });
        }),
    };
    workspace.interactions.recordToolCall();
    // Its step's PreToolUse hooks, recorded before the approval and the body.
    const pre =
      tool &&
      (yield* preToolUse(run, cell, step, fact, responseId, parsedInput));
    if (pre && pre.rows.length > 0) yield* append(pre.rows);
    let result: ToolResult;
    if (pre && pre.denied !== null) {
      result = pre.denied;
    } else if (!tool) {
      result = {
        status: 'error',
        error: `tool_unavailable: the tool "${fact.toolName}" is not available in this run. Continue with the tools you were offered.`,
        diagnostics: { code: 'tool_unavailable', tool: fact.toolName },
      };
    } else {
      // Guard first, under the step's roots and plugin services: a refused
      // path or unapproved command settles the call without the body running.
      const invoked = yield* Effect.exit(
        Effect.scoped(
          guardedToolCall(tool, parsedInput, pre?.bodyStarts).pipe(
            Effect.provideService(ToolCall, {
              roots: run.session.roots,
              run,
              workingDirectory: run.workingDirectory,
              stepRoots: step.stepRoots,
              tracker: workspace.interactions,
              workPlanState: workspace.workPlan,
              userInstruction,
              toolCallId: fact.callId,
              logId: fact.logId,
              responseId,
              attempt,
              requests,
              hooks: { onToolOutput },
              ...context,
            }),
            Effect.provide(step.services),
          ),
        ),
      );
      accepting = false;
      if (Exit.isSuccess(invoked)) {
        result = invoked.value;
      } else if (Cause.hasInterrupts(invoked.cause)) {
        // A finalizer may also have failed while cancellation drained a write.
        // Preserve that cause instead of replacing it with a bare interrupt.
        return yield* Effect.failCause(
          Cause.fromReasons<never>(
            invoked.cause.reasons.map((reason) =>
              Cause.isFailReason(reason)
                ? Cause.makeDieReason(reason.error)
                : reason,
            ),
          ),
        );
      } else {
        const refused = findStorageRefusal(invoked.cause);
        if (refused) return yield* Effect.fail(refused);
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
      catch: ensureError,
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
    const trackedEdits = workspace.interactions.recordEdits(
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
        const location = pathToLocationIn(
          run.session.roots.workspace,
          attachment.path,
        );
        const exists = yield* entryExists(fs, location.absolutePath).pipe(
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
        workspace.media.addMediaFiles(validLocations);
      }
    }
    const attachments = yield* captureAttachments(
      extracted.attachments,
      run.session.roots.workspace,
    );
    const status: ToolCallStatus =
      extracted.sanitizedResult.status === 'error' ? 'failed' : 'completed';
    // The whole card commits with the settlement: a slow tool's card is
    // already open and only closes here, and a fast tool's opens and closes
    // in this same batch under the id its dispatch facts carry. Publishing a
    // terminal card outside the batch would tell the transcript the call
    // completed while recovery still sees an unsettled call.
    const cards = settledCards(fact, parsedInput, status, attempt, editedFiles);
    // An executed call's PostToolUse rows commit with its settlement.
    const post = pre ? yield* pre.after(extracted.sanitizedResult) : [];
    yield* retireStanding;
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
        stateMutation: [],
      },
      [...cards, ...post],
      true,
    );
  });

  /** Ask whether an outcome-unknown call re-runs or is skipped (A3). */
  const decideOutcomeUnknown = Effect.fn('toolUse.outcomeUnknown')(function* (
    origin: ToolIntentOrigin,
    fact: CallFacts,
    input: unknown,
    intent: Pick<RunState['pendingIntents'][string], 'attempt' | 'binding'>,
  ): Effect.fn.Return<'rerun' | 'skip', InvokeError> {
    let current = yield* cell.current;
    const question = `The tool "${fact.toolName}" may have run before the run was interrupted, and no result was recorded. Run it again, or skip it?`;
    const rerunOption = 'Run again';
    // A person decides this barrier: the answer's chosen option, or a
    // `skip` (the host's own word for a person declining to answer), both
    // land as the request's `request.decided` (R5). A `deny` is a policy or
    // headless host with nobody to ask (yolo, never): it denies again on
    // every resume, so it is a skip, which never re-runs the call blindly.
    // A `cancel` was written by a cleanup (the run stopped, the session
    // closed), so it decides nothing and the barrier is asked again.
    const decided = (decision: RequestDecision): 'rerun' | 'skip' | null => {
      if (decision.action === 'submit') {
        return decision.answers[question] === rerunOption ? 'rerun' : 'skip';
      }
      return decision.action === 'skip' || decision.action === 'deny'
        ? 'skip'
        : null;
    };
    // Only the loop's own question answers this: the call's own request,
    // decided, says nothing about whether the body ran.
    const questionId =
      intent.binding?.role === 'outcome' ? intent.binding.requestId : null;
    const bound = current.requests[questionId ?? ''];
    if (bound !== undefined && bound.resolved && bound.decision !== null) {
      const answer = decided(bound.decision);
      if (answer !== null)
        return yield* recordOutcomeDecision(
          origin,
          fact,
          input,
          intent,
          answer,
        );
    }
    // A request the run committed and nobody answered is asked again under
    // its own id, so one barrier never accumulates requests. Anything else
    // opens a fresh one: the fold refuses a second `request.opened` on an id
    // it already carries, so a request retired without a decision cannot be
    // reopened, only replaced (and the binding row below rebinds the intent).
    const standing =
      questionId !== null && bound !== undefined && !bound.resolved
        ? questionId
        : null;
    const requestId = standing ?? `tool-outcome-${generateShortId()}`;
    const preview = deriveToolInputPreview(fact.toolName, input);
    const request = {
      requestId,
      allowBypass: false,
      runId,
      questions: [
        {
          question,
          header: 'Tool outcome',
          options: [
            { label: rerunOption, description: 'Execute the call once more.' },
            {
              label: 'Skip',
              description: 'Tell the model its outcome is unknown.',
            },
          ],
        },
      ],
      context: preview ? `${fact.toolName}: ${preview}` : fact.toolName,
    };
    // A request row is committed whenever no live request stands: the call
    // never raised one, or the one it raised was retired without a decision
    // and this opens its replacement, bound to the same call by the
    // `tool.binding` committed with it.
    if (standing === null) {
      const payload = { kind: 'userQuestion' as const, data: request };
      yield* append([
        {
          type: 'request.opened',
          aggregateId,
          requestId,
          payload,
          thread: null,
        },
        bindingRow(runId, {
          callId: fact.callId,
          attempt: intent.attempt,
          requestId,
          role: 'outcome',
        }),
        // `yolo` or a host that cannot present answers in the same batch.
        ...policyDecidedRows(run.session, runId, payload),
      ]);
      current = yield* cell.current;
      const policy = current.requests[requestId]?.decision;
      const answer = policy == null ? null : decided(policy);
      if (answer)
        return yield* recordOutcomeDecision(
          origin,
          fact,
          input,
          intent,
          answer,
        );
    }
    // The decision is the `request.decided` row the decide command lands on
    // the tail. A plane that closes first, and a cleanup's `cancel`, leave
    // the `tool.intent` bound and the request open, and the dispatch
    // interrupts so the next resume asks the same question again.
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
    yield* cell.fold(row, 'The tool-outcome decision');
    const answer = decided(row.decision);
    if (answer === null) return yield* Effect.interrupt;
    return yield* recordOutcomeDecision(origin, fact, input, intent, answer);
  });

  /** A rerun admits a new attempt with its `tool.intent` and reopens the
   *  card; a skip records nothing further, the decision row is the fact. */
  const recordOutcomeDecision = Effect.fn('toolUse.outcomeDecision')(function* (
    origin: ToolIntentOrigin,
    fact: CallFacts,
    input: unknown,
    intent: { readonly attempt: number },
    decision: 'rerun' | 'skip',
  ): Effect.fn.Return<'rerun' | 'skip', InvokeError> {
    if (decision === 'rerun') {
      yield* append([
        intentRow(origin, fact.callId, intent.attempt + 1),
        ...admittedCards(fact, input, intent.attempt + 1),
      ]);
    }
    return decision;
  });

  /**
   * The rules a call that may have run already follows, and its run: one
   * the replay rule admits re-runs, another is asked about, and a skip
   * closes the card the interrupted attempt opened.
   */
  const resumeIntent = Effect.fn('toolUse.resumeIntent')(function* (
    origin: ToolIntentOrigin,
    fact: CallFacts,
    input: unknown,
    intent: RunState['pendingIntents'][string],
    context: CallContext = {},
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    const current = yield* cell.current;
    // The call's own request, never answered: its body never ran past it,
    // so the attempt re-enters it and the answer completes the call. One
    // the run's stop retired as cancelled is asked again the same way.
    const ownId =
      intent.binding?.role === 'call' ? intent.binding.requestId : null;
    const own = ownId === null ? undefined : current.requests[ownId];
    if (ownId !== null && own !== undefined) {
      // Answered since this owner took the run, before its loop got here:
      // no waiter read it, so it is the call's answer too.
      const unread = own.resolved && current.decidedSinceActivation.has(ownId);
      if (!own.resolved || unread) {
        yield* execute(
          fact,
          input,
          intent.attempt,
          { requestId: ownId, decision: own.decision },
          context,
        );
        return;
      }
      if (own.decision?.action === 'cancel') {
        yield* execute(fact, input, intent.attempt, null, context);
        return;
      }
    }
    const decision = (yield* replayable(fact, step.registry, input, logger))
      ? yield* recordOutcomeDecision(origin, fact, input, intent, 'rerun')
      : yield* decideOutcomeUnknown(origin, fact, input, intent);
    if (decision === 'skip') {
      // The skip closes the card the interrupted attempt opened.
      yield* settle(
        fact,
        intent.attempt,
        syntheticSettlement(SKIPPED_OUTCOME_UNKNOWN),
        settledCards(fact, input, 'failed', intent.attempt),
      );
      return;
    }
    yield* execute(fact, input, intent.attempt + 1, null, context);
  });

  /**
   * The calls a response's call may issue as a script, each through this
   * same per-call program under the origin `{ kind: 'script' }`: its
   * `script.call` commits with its first intent, its card opens under the
   * script's stage, and its settlement is handed back at its `tool.result`
   * commit. A resumed script is handed back what its rows settled, in the
   * order those settlements committed, before any call runs again; a call
   * that was in flight follows the replay and outcome-unknown rules; and a
   * call at a recorded `seq` that is not the recorded one is a divergence.
   * Calls take their places in issue order: a parallel-safe call waits for
   * the barrier before it and runs under the parallel window, any other is a
   * barrier that waits for every call before it.
   */
  const scriptCallsOf = Effect.fn('toolUse.scriptCalls')(function* (
    script: DispatchFacts,
  ) {
    const services = yield* Effect.context<
      | ProcessServices
      | Runs
      | WorkspaceFs
      | StorageFs
      | FileSystem.FileSystem
      | Scope.Scope
    >();
    // Built when the call's tool first asks for it, so a call that issues
    // none allocates nothing; the dispatch's scope still owns the stage.
    return yield* Effect.cached(
      Effect.gen(function* () {
        const origin: ToolIntentOrigin = {
          kind: 'script',
          scriptCallId: script.callId,
        };
        const stageId = `script-${script.logId}`;
        const recorded = Object.values(
          (yield* cell.current).pendingResponse?.scriptCalls ?? {},
        ).filter((call) => call.scriptCallId === script.callId);
        // The settled calls, in the order their settlements committed: each is
        // handed back once the one before it reached the guest.
        const replayOrder = recorded
          .flatMap((call) =>
            call.settledAt === null
              ? []
              : [[call.settledAt, call.seq] as const],
          )
          .toSorted(([a], [b]) => a - b)
          .map(([, seq]) => seq);
        const delivered = new Map(
          replayOrder.map((seq) => [seq, Deferred.makeUnsafe<void>()]),
        );
        const handedBack = (seq: number | undefined) => {
          const done = seq === undefined ? undefined : delivered.get(seq);
          return done === undefined ? Effect.void : Deferred.await(done);
        };
        // Each call's place in issue order, and the barrier and parallel calls
        // a later call waits for.
        const placed = new Map<number, Deferred.Deferred<void>>();
        const placeOf = (seq: number) => {
          const existing = placed.get(seq);
          if (existing !== undefined) return existing;
          const created = Deferred.makeUnsafe<void>();
          placed.set(seq, created);
          return created;
        };
        const lanes = yield* SynchronizedRef.make<{
          readonly barrier: Deferred.Deferred<void> | null;
          readonly since: readonly Deferred.Deferred<void>[];
        }>({ barrier: null, since: [] });
        const window = yield* Semaphore.make(MAX_PARALLEL_TOOL_CALLS);
        const stageOpened = yield* Ref.make(false);
        const openStage = Effect.gen(function* () {
          if (yield* Ref.getAndSet(stageOpened, true)) return;
          run.session.publishRunEvent(runId, {
            type: 'stage.start',
            id: stageId,
            label: 'Script',
            kind: 'script',
            ...(script.stageId !== null ? { parentId: script.stageId } : {}),
          });
        });
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(stageOpened))) return;
            const settled = settledOf(yield* cell.current, script.callId);
            let status: 'completed' | 'failed' | 'cancelled' =
              settled?.result.status === 'executed' ? 'completed' : 'failed';
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
              status = 'cancelled';
            run.session.publishRunEvent(runId, {
              type: 'stage.end',
              id: stageId,
              status,
            });
          }),
        );

        /** Run `body` in `seq`'s place: after the calls it must follow. A
         *  tool that bounds its own calls runs beside the others, outside
         *  the window, and a later barrier still waits for it. */
        const inPlace = <A, E, R>(
          seq: number,
          tool: ITool | undefined,
          body: Effect.Effect<A, E, R>,
        ) =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            const beside =
              tool?.parallelSafe === true || tool?.ownsConcurrency === true;
            const after = yield* SynchronizedRef.modify(lanes, (lane) =>
              beside
                ? [[lane.barrier], { ...lane, since: [...lane.since, done] }]
                : [[lane.barrier, ...lane.since], { barrier: done, since: [] }],
            );
            yield* Deferred.succeed(placeOf(seq), undefined);
            yield* Effect.forEach(
              after,
              (call) => (call === null ? Effect.void : Deferred.await(call)),
              { discard: true },
            );
            return yield* (
              tool?.parallelSafe === true ? window.withPermits(1)(body) : body
            ).pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
          });

        // What the script's calls share while it runs here
        // (`ScriptScope.shared`).
        const sharedValues = new Map<
          string,
          Deferred.Deferred<unknown, unknown>
        >();
        const shared = <A, E, R>(
          key: string,
          make: Effect.Effect<A, E, R>,
        ): Effect.Effect<A, E, R> =>
          Effect.suspend(() => {
            const existing = sharedValues.get(key) as
              Deferred.Deferred<A, E> | undefined;
            if (existing !== undefined) return Deferred.await(existing);
            const made = Deferred.makeUnsafe<A, E>();
            sharedValues.set(key, made as Deferred.Deferred<unknown, unknown>);
            return make.pipe(
              Effect.onExit((exit) => Deferred.done(made, exit)),
            );
          });
        const scopeOf = (source: ScriptSource): ScriptScope => ({
          ...source,
          callId: script.callId,
          calls: Effect.map(cell.current, (state) =>
            Object.values(state.pendingResponse?.scriptCalls ?? {})
              .filter((call) => call.scriptCallId === script.callId)
              .toSorted((a, b) => a.seq - b.seq)
              .map(({ toolName, input }) => ({ toolName, input })),
          ),
          shared,
        });

        /** `op`'s `script.call` row, first committed with its first intent. */
        const scriptCallRow = (
          op: ScriptOp,
          fact: CallFacts,
          input: JsonValue,
        ) =>
          ({
            type: 'script.call',
            aggregateId,
            payload: {
              scriptCallId: script.callId,
              seq: op.seq,
              callId: fact.callId,
              toolName: fact.toolName,
              input,
              replay: fact.replay,
              logId: fact.logId,
              stageId,
              phase: op.phase,
            },
          }) satisfies RunLedgerDraft;

        /** Settles `op`: from its rows when they settled it; else by `answer`,
         *  one of the script's host functions, recorded with no card; else by
         *  running its tool through the per-call program. */
        const call = Effect.fn('toolUse.scriptCall')(function* (
          op: ScriptOp,
          source: ScriptSource | null,
          answer?: () => ToolResultPayload['result'],
        ) {
          const callId = `${script.callId}/${op.seq}`;
          if (op.seq > 0) yield* Deferred.await(placeOf(op.seq - 1));
          yield* openStage;
          const input = toJsonValue(op.input);
          const state = yield* cell.current;
          const known = state.pendingResponse?.scriptCalls[callId];
          if (
            known !== undefined &&
            (known.toolName !== op.name ||
              !isDeepStrictEqual(known.input, input))
          ) {
            return yield* new ScriptDiverged({
              seq: op.seq,
              recorded: `${known.toolName}(${JSON.stringify(known.input)})`,
              issued: `${op.name}(${JSON.stringify(input)})`,
            });
          }
          const settled = settledOf(state, callId);
          if (settled !== null) {
            // Replayed from its row: it takes no lane and does not run.
            yield* Deferred.succeed(placeOf(op.seq), undefined);
            yield* handedBack(replayOrder[replayOrder.indexOf(op.seq) - 1]);
            return { result: settled.result, attachments: settled.attachments };
          }
          if (answer !== undefined) {
            // It reads the pinned catalog only, and runs no tool: it takes no
            // lane, and commits whole, in one batch.
            yield* Deferred.succeed(placeOf(op.seq), undefined);
            yield* handedBack(replayOrder.at(-1));
            const result = answer();
            const intent = (yield* cell.current).pendingIntents[callId];
            const attempt = intent?.attempt ?? 1;
            yield* append([
              ...(known === undefined
                ? [
                    scriptCallRow(
                      op,
                      {
                        callId,
                        toolName: op.name,
                        replay: 'safe',
                        logId: generateShortId(),
                        stageId,
                      },
                      input,
                    ),
                  ]
                : []),
              ...(intent === undefined
                ? [intentRow(origin, callId, attempt)]
                : []),
              {
                type: 'tool.result',
                aggregateId,
                payload: {
                  responseId,
                  callId,
                  attempt,
                  disposition:
                    result.status === 'executed' ? 'executed' : 'failed',
                  duplicateOf: null,
                  result,
                  attachments: [],
                  stateMutation: [],
                },
              },
            ]);
            return { result, attachments: [] };
          }
          const tool = step.registry.get(op.name);
          const context = source === null ? {} : { script: scopeOf(source) };
          yield* inPlace(
            op.seq,
            tool,
            Effect.gen(function* () {
              // Nothing runs again until the guest holds everything that settled.
              yield* handedBack(replayOrder.at(-1));
              const fact: CallFacts = known ?? {
                callId,
                toolName: op.name,
                replay: tool?.replay ?? 'unsafe',
                logId: generateShortId(),
                stageId,
                phase: op.phase,
              };
              const intent = (yield* cell.current).pendingIntents[callId];
              if (known !== undefined && intent !== undefined) {
                return yield* resumeIntent(
                  origin,
                  fact,
                  input,
                  intent,
                  context,
                );
              }
              yield* append([
                ...(known === undefined
                  ? [scriptCallRow(op, fact, input)]
                  : []),
                intentRow(origin, callId, 1),
                ...admittedCards(fact, input, 1),
              ]);
              yield* execute(fact, input, 1, null, context);
            }),
          );
          const settledNow = settledOf(yield* cell.current, callId);
          if (settledNow === null) {
            return yield* Effect.die(
              new Error(`Script call ${callId} is unsettled after its run.`),
            );
          }
          return {
            result: settledNow.result,
            attachments: settledNow.attachments,
          };
        });

        const plugins = new Map(
          step.offered.map(({ name, plugin }) => [name, plugin]),
        );
        return {
          catalog: step.definitions
            .filter(({ name }) => name !== script.toolName)
            .map((definition) => ({
              definition,
              plugin: plugins.get(definition.name) ?? 'run',
            })),
          globals: step.definitions.flatMap(({ name }) => {
            const global =
              name === script.toolName
                ? undefined
                : step.registry.get(name)?.scriptGlobal;
            return global === undefined
              ? []
              : [{ tool: name, positional: global.positional }];
          }),
          call: (op: ScriptOp, source: ScriptSource) =>
            call(op, source).pipe(Effect.provideContext(services)),
          answer: (op: ScriptOp, answer: () => ToolResultPayload['result']) =>
            call(op, null, answer).pipe(
              Effect.map(({ result }) => result),
              Effect.provideContext(services),
            ),
          delivered: (seq: number) => {
            const done = delivered.get(seq);
            return done === undefined
              ? Effect.void
              : Deferred.succeed(done, undefined).pipe(Effect.asVoid);
          },
        } satisfies ScriptCalls;
      }).pipe(Effect.provideContext(services)),
    );
  });

  /** One call of a partition: the resume rules, then execution. */
  const dispatchCall = Effect.fn('toolUse.dispatchCall')(function* (
    fact: DispatchFacts,
    afterEndTurn: boolean,
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    const current = yield* cell.current;
    if (settledOf(current, fact.callId) !== null) return;
    const call = calls[fact.ordinal];
    if (call === undefined) {
      return yield* Effect.die(new Error(`No call at ordinal ${fact.ordinal}`));
    }
    if (afterEndTurn) {
      yield* settle(fact, 1, syntheticSettlement(SKIPPED_AFTER_END_TURN), []);
      return;
    }
    const input = parseCallArguments(call, logger);
    const intent = current.pendingIntents[fact.callId];
    if (intent !== undefined) {
      yield* Effect.scoped(
        Effect.flatMap(scriptCallsOf(fact), (scriptCalls) =>
          resumeIntent(fromResponse, fact, input, intent, { scriptCalls }),
        ),
      );
      return;
    }
    if (recovered) {
      yield* settle(fact, 1, syntheticSettlement(SKIPPED_NOT_STARTED), []);
      return;
    }
    // The intent precedes every call, parallel-safe or not, and a slow
    // tool's card opens in the same batch.
    yield* append([
      intentRow(fromResponse, fact.callId, 1),
      ...admittedCards(fact, input, 1),
    ]);
    yield* Effect.scoped(
      Effect.flatMap(scriptCallsOf(fact), (scriptCalls) =>
        execute(fact, input, 1, null, { scriptCalls }),
      ),
    );
  });

  /** A duplicate derives its primary's settlement, effects stripped. */
  const deriveDuplicate = Effect.fn('toolUse.duplicate')(function* (
    fact: DispatchFacts,
    primaryId: string,
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    const current = yield* cell.current;
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
    );
  });

  // Partitions in order; each barrier is its own, each run of parallel-safe
  // calls shares one and executes under the window.
  const partitions = Map.groupBy(pending.calls, (fact) => fact.partition);
  // A script's calls are not the response's: its own result says whether
  // one of them ended the turn.
  let endTurn = pending.calls.some((fact) => {
    const settled = pending.settled[fact.callId];
    return settled !== undefined && endsTurn(settled);
  });
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
    const after = yield* cell.current;
    if (!endTurn) {
      endTurn = members.some((fact) => {
        const settled = settledOf(after, fact.callId);
        return settled !== null && endsTurn(settled);
      });
    }
  }

  // Delivery: the paid turn enters history once, with the complete group.
  const settledState = yield* cell.current;
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
      content: [
        ...settlementContent(
          { ...settlement, stateMutation: [] },
          bound,
          logger,
        ),
        // What the call's hooks add, after its result.
        ...callHookText(settledState, responseId, fact.callId),
      ],
    };
  });
  // Offer each delivered document to the binding's upload cache, so the
  // requests that replay this history can send a file id instead of the
  // bytes. Concurrent under the same in-flight bound as parallel tool
  // calls, the batch under one aggregate deadline: a stalled files
  // endpoint delays delivery by at most one deadline however many
  // documents there are, warns with the paths that never finished, and
  // changes nothing the model reads now. The binding deletes what it
  // uploaded when it closes. A batch that ends the turn completes the run
  // straight after this delivery (the same `endTurn` this dispatch
  // returns), and a batch delivered while a model switch waits for the
  // next boundary is replayed by the replacement binding, whose cache
  // never saw these ids: both keep their documents local. The optional
  // upload is looked for only when there is a document to give it.
  const documents = (
    endTurn || run.pendingModelSwitch.value !== null ? [] : settledPending.calls
  ).flatMap((fact) =>
    (settledPending.settled[fact.callId]?.attachments ?? []).flatMap(
      (attachment) => {
        if (attachment.content.kind !== 'base64') return [];
        const part = inlineMediaPart(
          attachment.mimeType,
          attachment.content.data,
          bound,
        );
        return part?.kind === 'document'
          ? [{ path: attachment.path, part }]
          : [];
      },
    ),
  );
  const uploadFile =
    documents.length === 0 ? undefined : bound.model.uploadFile;
  if (uploadFile !== undefined) {
    // Settled uploads leave the set; the aggregate deadline names the rest.
    const pendingUploads = new Set(documents.map(({ path }) => path));
    yield* Effect.forEach(
      documents,
      ({ path, part }) =>
        uploadFile({
          mimeType: part.mimeType,
          filename: getBasename(path) || 'attachment',
          base64: part.base64,
        }).pipe(
          Effect.catchTag('ModelError', (error) =>
            Effect.sync(() =>
              logger.warn(
                `Sending "${path}" as bytes: the provider did not accept it as an upload (${error.message}).`,
              ),
            ),
          ),
          Effect.tap(Effect.sync(() => pendingUploads.delete(path))),
        ),
      { concurrency: MAX_PARALLEL_TOOL_CALLS, discard: true },
    ).pipe(
      // The dispatch runs inside the loop's uninterruptible handoff; the
      // aggregate deadline only bounds the uploads if it can interrupt
      // them, so say it here rather than depend on how the race forks.
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: UPLOAD_DEADLINE,
        orElse: () =>
          Effect.sync(() =>
            logger.warn(
              `Sending ${[...pendingUploads].map((path) => `"${path}"`).join(', ')} as bytes: their uploads did not finish within ${UPLOAD_DEADLINE} in all.`,
            ),
          ),
      }),
    );
  }
  const group: Message = { role: 'tool', results };
  const saved = settledState.loop;
  if (saved === null)
    return yield* Effect.die(new Error('Delivery needs an opened run.'));
  const stateSlices =
    saved.stateSlices === null
      ? null
      : {
          ...saved.stateSlices,
          workspaceSnapshot: workspace.toSnapshot(),
        };
  const delivered = yield* cell.append((state) => [
    appendRow(runId, [group], responseId),
    ...(joined?.rows ?? []),
    ...snapshotRow(runId, state, {
      state: { ...saved, stateSlices, ...joined?.recorded },
    }),
    positionRow(runId, state, 'results.ready'),
  ]);
  return { state: delivered, endTurn };
});
