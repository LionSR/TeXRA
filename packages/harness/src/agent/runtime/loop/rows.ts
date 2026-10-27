/**
 * The loops' row constructors: every run history draft a loop appends, built
 * from the folded `RunState` and nothing else. A `run.position` is the one
 * record of where the loop stands; a `run.config` is what the run runs on
 * (its model and binding); an `append` carries what its messages change
 * about the run's input. Every fact a row already carries (the pending
 * response, its intents, the invocation's attempts
 * and failures) is folded from that row and never restated here.
 */

import { randomUUID } from 'node:crypto';

import { Effect, SynchronizedRef } from 'effect';

import type { RunRecord } from '@agent/core/definition/RunRecord';
import {
  qualifyAggregateId,
  toJsonValue,
  type AggregateId,
  type DispatchFacts,
  type FileListEntry,
  type PositionAt,
  type RunBinding,
  type RunId,
  type RunInput,
  type RunOutcome,
  type ScriptCallPayload,
  type SessionEvent,
  type ToolCallStatus,
} from '@shared/schemas';
import type { DraftBlob } from '@shared/session/historyTurns';
import type { CallResult } from '@shared/session/inFlight';
import { consumedRow } from '@shared/session/runFacts';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { generateShortId } from '@utils/core';
import { dispatchFactsFor } from '../run/tools';
import { addressedMessages, type AppendedMessage } from '../storedTurn';

import type { AgentRunShape } from '../run/AgentRun';
import type { RuntimeTool } from '../ToolServices';

/** A message the loop appends (`addressedMessages`). */
export type Message = AppendedMessage;

/** The aggregate id every row of run `runId`'s history is filed under. */
export function rowAggregate(runId: RunId): AggregateId {
  return qualifyAggregateId('run', runId);
}

/** The row making `text` the response shown as final: a row of the run's
 *  history, awaited, never a detached trace row. */
export const finalizedRows = (
  runId: RunId,
  text: string,
): RunHistoryDraft[] => [
  { type: 'response.finalized', aggregateId: rowAggregate(runId), text },
];

/** The coordinates a `run.position` row is stamped with. */
export type PositionCoordinates = Pick<RunState, 'turn'>;

/** Where the loop stands; a run's first one opens it. */
export function positionRow(
  runId: RunId,
  state: PositionCoordinates,
  at: Exclude<PositionAt, 'halted'>,
): RunHistoryDraft {
  return {
    type: 'run.position',
    aggregateId: rowAggregate(runId),
    payload: { family: 'toolUse', at, turn: state.turn },
  };
}

/** The loop's halt where its newest position left it, with the run's
 *  outcome: written only with the run's `run.end`, so a stopped run never
 *  reads as interrupted. */
export function haltedPositionRow(
  position: Extract<SessionEvent, { type: 'run.position' }>,
  outcome: RunOutcome,
): Extract<RunHistoryDraft, { type: 'run.position' }> {
  const { family, turn } = position.payload;
  return {
    type: 'run.position',
    aggregateId: position.aggregateId,
    payload: { family, at: 'halted', turn, outcome },
  };
}

/** Messages appended to the run's history: `input` is what they change
 *  about what the run answers, `reason` names a message the loop wrote
 *  itself (`model.message` `append`). */
export function appendRow(
  runId: RunId,
  messages: readonly Message[],
  options: {
    readonly sourceResponse?: string | null;
    readonly input?: RunInput;
    readonly reason?: 'blank-continuation' | 'final-tool';
  } = {},
): RunHistoryDraft {
  const { sourceResponse = null, input, reason } = options;
  // Media bytes go to the blob table with the row; the row keeps addresses.
  const addressed = addressedMessages(messages);
  return {
    type: 'model.message',
    aggregateId: rowAggregate(runId),
    payload: {
      kind: 'append',
      messages: addressed.messages,
      sourceResponse,
      ...(input !== undefined && Object.keys(input).length > 0 && { input }),
      ...(reason !== undefined && { reason }),
    },
    ...(addressed.blobs.length > 0 && { blobs: addressed.blobs }),
  };
}

/**
 * The run's `run.config` on `model` and `binding`: the configuration the run
 * was launched (or resumed) with, and what the loop bound, written when the
 * run first binds and at a model switch, in the batch that puts the binding
 * in force.
 */
export function configRow(
  runId: RunId,
  config: RunRecord,
  model: string,
  binding: RunBinding,
): RunHistoryDraft {
  return {
    type: 'run.config',
    aggregateId: rowAggregate(runId),
    config: { ...config, model },
    binding,
  };
}

/** The `tools.offered` row recording what a step offers, written when it
 *  differs from what the run last recorded (`step.ts`). */
export function offeredRow(
  runId: RunId,
  payload: Extract<RunHistoryDraft, { type: 'tools.offered' }>['payload'],
): RunHistoryDraft {
  return { type: 'tools.offered', aggregateId: rowAggregate(runId), payload };
}

/** What a tool call's rows name of it, whichever origin issued it: a
 *  response's dispatch fact, or a script's `script.call`, which commits
 *  with the call's first row. */
export type CallFacts =
  | Pick<DispatchFacts, 'callId' | 'toolName' | 'replay' | 'logId'>
  | ScriptCallPayload;

/** The `script.call` a call carries, or null for a response's own. */
export const scriptOf = (fact: CallFacts): ScriptCallPayload | null =>
  'scriptCallId' in fact ? fact : null;

/** The display row that opens a call's card at `attempt`, shown as `tool`
 *  renders the call's input; it commits in the batch with a run history
 *  row (a slow tool's intent, or the result). */
export function cardStartRow(
  runId: RunId,
  fact: CallFacts,
  input: unknown,
  attempt: number,
  tool: RuntimeTool | undefined,
): RunHistoryDraft {
  const script = scriptOf(fact);
  return {
    type: 'tool.start',
    aggregateId: rowAggregate(runId),
    logId: fact.logId,
    toolName: fact.toolName,
    input: toJsonValue(input),
    card: tool?.definition.card?.(input),
    ...(script?.phase != null ? { phase: script.phase } : {}),
    ...(attempt > 1 ? { attempt } : {}),
    ...(script !== null ? { stageId: script.stageId } : {}),
  };
}

/** The display row that closes a call's card, in the batch of its result. */
export function cardEndRow(
  runId: RunId,
  fact: CallFacts,
  status: ToolCallStatus,
  files: readonly FileListEntry[],
): RunHistoryDraft {
  const script = scriptOf(fact);
  return {
    type: 'tool.end',
    aggregateId: rowAggregate(runId),
    logId: fact.logId,
    status,
    ...(files.length > 0 ? { files: [...files] } : {}),
    ...(script !== null ? { stageId: script.stageId } : {}),
  };
}

/** The `script.call` that issues a script's call: it commits with the
 *  call's first row, whichever that is. */
export function scriptCallRow(
  runId: RunId,
  script: ScriptCallPayload,
): RunHistoryDraft {
  return {
    type: 'script.call',
    aggregateId: rowAggregate(runId),
    payload: script,
  };
}

/** The `tool.result` that settles call `callId` of response `responseId` at
 *  `attempt`, with the attachment bytes it stores or links (`blobs`). */
export function toolResultRow(
  runId: RunId,
  responseId: string,
  callId: string,
  attempt: number,
  result: Omit<CallResult, 'attempt'>,
  blobs: readonly DraftBlob[],
): RunHistoryDraft {
  return {
    type: 'tool.result',
    aggregateId: rowAggregate(runId),
    payload: { responseId, callId, attempt, ...result },
    ...(blobs.length > 0 && { blobs }),
  };
}

/** The `tool.intent` that says `fact`'s body starts `attempt`. */
export function intentRow(
  runId: RunId,
  responseId: string,
  fact: CallFacts,
  attempt: number,
): RunHistoryDraft {
  const script = scriptOf(fact);
  return {
    type: 'tool.intent',
    aggregateId: rowAggregate(runId),
    payload: {
      origin:
        script === null
          ? { kind: 'response', responseId }
          : { kind: 'script', scriptCallId: script.scriptCallId },
      callId: fact.callId,
      attempt,
    },
  };
}

/** The tool a script's run calls: `script`, whatever launched the run. */
export const SCRIPT_TOOL_NAME = 'script';

/**
 * The row of a script's run's one call (`AgentConfig.script`): the call the
 * application handed it, which no model produced, so it records no attempt,
 * origin or usage. It stands as the pending response the loop dispatches.
 * Committed once, in the run's opening batch.
 */
export const handedDown = Effect.fn('rows.handedDown')(function* (
  run: Pick<AgentRunShape, 'steps' | 'logger' | 'runId'>,
  call: NonNullable<AgentRunShape['config']['script']>,
) {
  const { runId } = run;
  const argumentsText = JSON.stringify({
    code: call.code,
    title: call.title,
    ...(call.timeoutMs != null && { timeoutMs: call.timeoutMs }),
  });
  const [facts] = dispatchFactsFor(
    [{ callId: SCRIPT_CALL_ID, name: SCRIPT_TOOL_NAME, argumentsText }],
    (yield* SynchronizedRef.get(run.steps))?.tools.registry,
    run.logger,
    generateShortId,
  );
  if (facts === undefined)
    return yield* Effect.die(new Error('One call in, one dispatch fact out.'));
  return {
    type: 'model.message',
    aggregateId: rowAggregate(runId),
    payload: {
      kind: 'handed-down',
      responseId: randomUUID(),
      call: facts,
      argumentsText,
    },
  } satisfies RunHistoryDraft;
});

/** The call id of a script run's one call (`AgentConfig.script`): its
 *  nested calls are `script/<seq>`. */
const SCRIPT_CALL_ID = 'script';

/** The `followup.consumed` rows of the run's pending requests of `kind`,
 *  or of every kind. */
export const consumedRows = (
  runId: RunId,
  controls: readonly QueuedFollowUp[],
  kind?: NonNullable<QueuedFollowUp['control']>['kind'],
): Extract<RunHistoryDraft, { type: 'followup.consumed' }>[] =>
  controls.flatMap(({ followUpId, control }) =>
    control !== undefined && (kind === undefined || control.kind === kind)
      ? [consumedRow(runId, followUpId)]
      : [],
  );
