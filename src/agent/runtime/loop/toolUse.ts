/**
 * The tool-use program: one plain Effect loop over the run history, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state every `appendBatch`
 * returns, which is what makes the live path and the resume path the same
 * function.
 *
 * The write points, in order (manifest section 1.2): the opening batch of a
 * fresh run (initial message, `run.snapshot`); `turn.begin`; per round the
 * invoker's `attempt` / `identified` / `response` rows; per barrier call its
 * `tool.intent`; per settled call its `tool.result` with its card; the
 * delivering `append` with the complete tool group; `turn.end` and `waiting`
 * with the snapshot that precedes them; the follow-up consumption; and the
 * `halted` step at every exit that ends the run.
 *
 * Resume reads only row data off the fold: a `waiting` phase re-enters the
 * wait (a batch consumed at `turn.ready` runs its turn), an unanswered open
 * attempt invokes again under its gate, a pending response dispatches what
 * is unsettled, and a halted run launched again waits for its input.
 *
 * A run opened on a script (`AgentConfig.script`: a background script, a
 * document task's recipe) makes that one call instead of asking its model
 * and ends when it settles.
 */

import { Deferred, Effect, Exit, type Scope, SynchronizedRef } from 'effect';
import { z } from 'zod';

import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { FollowUpBatch } from '@agent/followUp/RunInput';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { logUserMessage } from '@agent/trace';
import { toolDefinitionsFor } from '@agent/core/tools/toolSchema';
import type { ProcessServices } from '@platform/processRuntime';
import { LanguageModel } from '@platform/languageModel';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  type JsonValue,
  type RetryErrorInfo,
  type RunOutcome,
  type RunUsageTotals,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { sha256 } from '@tools/catalogEntries';

import { AgentRun } from '../run/AgentRun';
import { backgroundCompaction } from '../run/compaction';
import { mediaInputParts, type InputPart } from '../run/mediaInput';
import { stored } from '../run/requestContext';
import { claimFollowUps, type ConsumedFollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { Runs } from '../runRegistry';
import {
  appendRow,
  handedDown,
  scriptSettlement,
  rowAggregate,
  snapshotRow,
  positionRow,
  type SnapshotPatch,
  type ToolUseLoopState,
} from './rows';
import {
  loadRun,
  makeRunCell,
  settleRun,
  stagedBy,
  stoppedBy,
  type RunCell,
  type RunExit,
} from './runProgram';
import { dispatchPendingResponse } from './toolUseDispatch';
import { openingHooks, stopHooks } from './hooks';
import { stepFor, type RunSystem } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import type { RunControls } from '../RunHandle';
import type { ChildRunBoundary } from '../childRunLoop';

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

type HistoryMessage = RunState['messages'][number];

/** The text an assistant message answers with. */
const answerOf = (
  message: Extract<HistoryMessage, { readonly role: 'assistant' }>,
): string =>
  message.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');

/** Whether the view ends on the request a `/compact` queued: its compaction
 *  is still owed, since the edit that compacts replaces the view holding it. */
const owesCompaction = (
  message: { readonly role: string } | undefined,
): boolean => {
  if (message?.role !== 'user' || !('content' in message)) return false;
  const { content } = message;
  return (
    Array.isArray(content) &&
    content.length === 1 &&
    (content[0] as { readonly text?: unknown }).text ===
      IMMEDIATE_COMPACTION_FOLLOW_UP
  );
};

export interface ToolUseStart {
  /** The caller launched this as a resume; the run history decides what it is. */
  readonly resume: boolean;
  /** A native child's turn permit, and the settlement its boundary commits. */
  readonly turns?: ChildRunBoundary<ToolUseResult>;
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(controls: RunControls): void;
    detach(controls: RunControls): void;
  };
}

interface ToolUseResult {
  readonly outcome: RunOutcome;
  readonly response: string;
  /** Workspace-relative paths of files edited by tool calls. */
  readonly files: readonly string[];
  readonly usage: RunUsageTotals;
  readonly structured: JsonValue | undefined;
  readonly error?: RetryErrorInfo;
}

export const runToolUse = Effect.fn('toolUse.run')(function* (
  start: ToolUseStart,
): Effect.fn.Return<
  ToolUseResult,
  Error,
  | AgentRun
  | RunHistory
  | ProcessServices
  | Runs
  | ModelInvoker
  | WorkspaceFs
  | StorageFs
  | Scope.Scope
> {
  const run = yield* AgentRun;
  const runHistory = yield* RunHistory;
  const runs = yield* Runs;
  const invoker = yield* ModelInvoker;
  const languageModel = yield* LanguageModel;
  const { runId, session, logger } = run;
  const isChild = () => (runs.getHandle(runId)?.parent ?? null) !== null;
  // A script's run: it opens on the call it was handed and ends when that
  // call settles.
  const script = run.config.script ?? null;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = yield* claimFollowUps(run, runHistory);
  const compaction = yield* backgroundCompaction({
    runId,
    runHistory,
    logger,
    invoker,
    stores: session.roots,
  });

  // ---------------------------------------------------------------- state
  let workspace = AgentWorkspaceState.create();
  // Recorded facts a restore reads back.
  let memoryMisses = run.opening?.attachedMemoryMisses ?? [];
  let systemPrompt: string | undefined;
  let response = '';
  // A `/compact` the host admitted: done at the next model boundary.
  let compactionRequested = false;

  /** The family state every snapshot of this run carries. The instruction
   *  and activated skills are the folded state's: only the transaction that
   *  consumes a delivery changes them. */
  const loopState = (state: RunState): ToolUseLoopState => {
    const { instruction, activated } = state.loop ?? {};
    return {
      stateSlices: {
        workspaceSnapshot: workspace.toSnapshot(),
      },
      ...(systemPrompt !== undefined ? { system: sha256(systemPrompt) } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(activated !== undefined ? { activated } : {}),
      ...(memoryMisses.length > 0 ? { memoryMisses } : {}),
      ...(run.structured.value !== undefined
        ? { structured: run.structured.value }
        : {}),
    };
  };
  const snapshot = (state: RunState, patch: Omit<SnapshotPatch, 'state'>) =>
    snapshotRow(runId, state, { ...patch, state: loopState(state) });

  // A resumed root's first continuation-pinning step stands it down first.
  let resumeUnseen = start.resume;
  // What a step's system text and skill roots are built from.
  const system: RunSystem = {
    base: () => systemPrompt,
    // The opening's before its snapshot records them.
    activated: (state) =>
      state.loop === null
        ? (run.opening?.activated ?? [])
        : (state.loop.activated ?? []),
    isChild,
  };
  const openStep = (state: RunState, kind: 'request' | 'dispatch' | 'park') =>
    Effect.tap(stepFor(run, state, kind, system), (step) => {
      if (!resumeUnseen || step.continuation === null || isChild())
        return Effect.void;
      resumeUnseen = false;
      return step.continuation
        .onResume({ session, runId })
        .pipe(Effect.provide(step.tools.services));
    });

  // ------------------------------------------------------------ host port
  let live = false;
  const controls: RunControls = {
    oneShot: run.toolPolicy.stopAfterCycle === true,
    requestImmediateCompaction(): void {
      compactionRequested = true;
      // A parked loop wakes on a synthetic turn; the compaction runs before
      // that turn's request, and the message tells the model to do nothing.
      if (!followUps.hasQueued()) {
        followUps.appendSynthetic(IMMEDIATE_COMPACTION_FOLLOW_UP);
      }
    },
    // Applied at the loop's next park, before any input it takes there: a
    // park is a settled position, so the edit never cuts a turn.
    editView: (handoff) =>
      Effect.gen(function* () {
        if (isChild() || run.toolPolicy.stopAfterCycle)
          return yield* Effect.fail(
            new Error(
              'Only a conversation that waits for its user can be reset.',
            ),
          );
        const done = yield* Deferred.make<void, Error>();
        if (!followUps.editView({ handoff, done }))
          return yield* Effect.fail(
            new Error('This task is already being reset.'),
          );
        yield* Deferred.await(done);
      }),
    ...modelSwitchPort(run, languageModel),
  };
  const attach = (): void => {
    if (live) return;
    live = true;
    start.attachment?.attach(controls);
  };
  const detach = (): void => {
    if (!live) return;
    live = false;
    start.attachment?.detach(controls);
  };

  // -------------------------------------------------------------- opening
  const openFresh = Effect.fn('toolUse.open')(function* (
    opening: RunState,
  ): Effect.fn.Return<RunState, Error, ProcessServices> {
    // Keep preparation interruptible inside the masked acquire.
    const { bound, content, offered } = yield* Effect.interruptible(
      Effect.gen(function* () {
        const bound = yield* SynchronizedRef.get(run.model);
        // A script's run renders no prompt: what it runs is its call.
        if (script !== null) {
          const step = yield* openStep(opening, 'request');
          const content: InputPart[] = [
            { kind: 'text', text: `Run the script "${script.title}".` },
          ];
          return { bound, content, offered: step.rows };
        }
        const { inputs } =
          run.opening ?? (yield* Effect.die(new Error(`${runId}: no opening`)));
        const prompts = yield* buildInitialToolUsePrompts(
          run.persona.prompt,
          inputs,
          {
            workspace: session.roots.workspace,
            settings: session.roots,
            textOnly: bound.textOnly,
          },
        );
        systemPrompt = [prompts.systemPrompt, prompts.instructionSuffix]
          .filter(Boolean)
          .join('\n');
        // The first step renders the prompt, and stores its base text.
        const step = yield* openStep(opening, 'request');
        // The user's task is the user message.
        const userRequest = run.config.instruction.trim();
        if (!userRequest)
          return yield* Effect.fail(
            new Error('A conversation requires a non-empty task.'),
          );
        const content: InputPart[] = [];
        const media = yield* Effect.exit(
          run.config.mediaFiles.length
            ? mediaInputParts(
                run.config.mediaFiles.map((p) =>
                  run.fileService.createLocation(p),
                ),
                bound,
                logger,
                run.session.roots.config,
              )
            : Effect.succeed({ parts: [], kinds: [] }),
        );
        if (run.initialUserMessageForTranscript) {
          logUserMessage(
            logger,
            run.initialUserMessageForTranscript,
            Exit.isSuccess(media) ? media.value.kinds : [],
          );
        }
        if (Exit.isFailure(media)) return yield* Effect.failCause(media.cause);
        content.push(...media.value.parts);
        content.push({ kind: 'text', text: userRequest });
        const hooked = yield* openingHooks(run, opening, userRequest);
        content.push(...hooked.parts);
        workspace = AgentWorkspaceState.create();
        return { bound, content, offered: [...step.rows, ...hooked.rows] };
      }),
    );
    const activated = run.opening?.activated ?? [];
    const opened = yield* runHistory.appendBatch(runId, null, [
      ...(content ? [appendRow(runId, [{ role: 'user', content }])] : []),
      ...offered,
      ...snapshotRow(runId, opening, {
        runtime: {
          modelId: bound.modelId,
          backend: bound.backend,
        },
        state: {
          ...loopState(opening),
          ...(activated.length > 0 ? { activated: [...activated] } : {}),
        },
      }),
    ]);
    run.callbacks.onProgress?.({ kind: 'started' });
    return opened;
  });

  const restore = (state: RunState): void => {
    const saved = state.loop;
    if (saved === null) {
      throw new Error(`Run ${runId} is not a toolUse run; resume it as one.`);
    }
    if (saved.stateSlices)
      workspace = AgentWorkspaceState.fromSnapshot(
        saved.stateSlices.workspaceSnapshot,
      );
    systemPrompt = saved.system && stored(state, saved.system, z.string());
    memoryMisses = saved.memoryMisses ?? [];
    if (saved.structured !== undefined) run.structured.value = saved.structured;
    const last = state.messages.at(-1);
    // A run parked after a turn answers with that turn's text, which a
    // resumed child that runs no further turn hands its call.
    if (
      (state.phase === 'waiting' || state.phase === 'halted') &&
      last?.role === 'assistant'
    )
      response = answerOf(last);
    logger.debug('Resuming tool-use run from the run history.');
  };

  // ------------------------------------------------------------ the turn
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
  ): Effect.fn.Return<
    RunExit,
    Error,
    AgentRun | RunHistory | ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    let state = yield* cell.current;
    // A turn begins at a settled boundary; a resumed one where its rows left.
    const begins =
      state.phase === 'initial' ||
      state.phase === 'waiting' ||
      state.phase === 'halted';
    let continuedAt: number | null = null;
    let finalToolAttempted = false;
    workspace.workPlan.setOnUpdate({
      onPlanUpdate: (plan) => {
        logger.emit({ type: 'run.fact', fact: { key: 'plan', plan } });
        run.callbacks.onProgress?.({ kind: 'plan', plan });
      },
    });
    /** The turn's completed exit; the stage closes with its own verdict. */
    const completeTurn = (at: RunState): RunExit => ({
      state: at,
      outcome: 'completed',
    });
    const scriptEnd = Effect.fn('toolUse.scriptEnd')(function* (at: RunState) {
      const settled = yield* scriptSettlement(session, runId);
      if (settled?.failed !== true) {
        if (settled?.value !== undefined) run.structured.value = settled.value;
        return completeTurn(at);
      }
      response = settled.reply;
      return { state: at, outcome: 'failed' } satisfies RunExit;
    });
    const body = Effect.gen(function* () {
      if (begins) {
        response = '';
        state = yield* cell.append([
          ...snapshot(state, {}),
          positionRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
        ]);
      }
      if (script !== null && state.round === 0)
        state = yield* cell.append(yield* handedDown(run, state, script));
      let forcedTool: string | null = null;
      /**
       * The policy a text-only response runs once it is committed: a blank
       * turn after a tool result asks once more, the terminal tool gets one
       * forced turn, and otherwise the turn ends with this text. `done` is
       * the end of the turn; anything else continues the loop.
       */
      const afterTextResponse = Effect.fn('toolUse.afterTextResponse')(
        function* (
          at: RunState,
          text: string,
          /** A response this turn just received, not one a resume replays. */
          live: boolean,
          /** Its answer is not yet finalized for display: always a live
           *  one's, and a replayed one's whose finalization never committed. */
          finalize: boolean = live,
        ): Effect.fn.Return<
          { readonly state: RunState; readonly done: boolean },
          Error,
          | AgentRun
          | RunHistory
          | ProcessServices
          | Runs
          | WorkspaceFs
          | StorageFs
        > {
          let next = at;
          const previous = next.messages.at(-2);
          if (
            !text.trim() &&
            previous?.role === 'tool' &&
            continuedAt !== next.messages.length
          ) {
            continuedAt = next.messages.length;
            next = yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [
                    { kind: 'text', text: BLANK_TOOL_RESULT_CONTINUATION },
                  ],
                },
              ]),
            ]);
            return { state: next, done: false };
          }
          if (text && finalize)
            logger.emit({ type: 'response.finalized', text });
          if (
            run.finalToolName !== null &&
            !finalToolAttempted &&
            run.structured.value === undefined
          ) {
            finalToolAttempted = true;
            forcedTool = run.finalToolName;
            next = yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: FINAL_TOOL_INSTRUCTION }],
                },
              ]),
            ]);
            return { state: next, done: false };
          }
          return { state: next, done: true };
        },
      );
      // A committed response whose live post-processing never ran is replayed
      // through the same policy, once, when this turn is entered (the rows
      // say so: its step, no open attempt). Treating it as finished would
      // skip the blank-turn continuation and the forced structured output.
      let replayCommitted = true;
      for (;;) {
        state = yield* applyPendingModelSwitch(state, cell, snapshot, (at) =>
          compaction.settle(at, 'the model is switching'),
        );
        if (state.pendingResponse !== null) {
          // A user's follow-up to a stopped response joins its delivery.
          const joined = yield* followUps.joinStopped(state);
          const dispatched = yield* dispatchPendingResponse(
            cell,
            workspace,
            (yield* openStep(state, 'dispatch')).tools,
            joined,
          );
          state = dispatched.state;
          joined?.delivered();
          // A script's run ends with its one call.
          if (script !== null && !joined) return yield* scriptEnd(state);
          if (dispatched.endTurn && !joined) return completeTurn(state);
          continue;
        }
        // A script's run asks no model: delivered, it ends as its call did.
        if (script !== null && state.round > 0) return yield* scriptEnd(state);
        if (replayCommitted) {
          replayCommitted = false;
          const last =
            state.at === 'response.ready' && state.openAttempt === null
              ? state.messages.at(-1)
              : undefined;
          if (last?.role === 'assistant') {
            const text = answerOf(last);
            if (text) response = text;
            // Its `response.finalized` is a trace row a later commit carries:
            // finalized iff one landed after the batch that made it ready.
            const rows = text
              ? yield* session.readAggregate(rowAggregate(runId), [
                  'run.position',
                  'response.finalized',
                ])
              : [];
            const ready = rows.findLast(
              (row) =>
                row.type === 'run.position' &&
                row.payload.at === 'response.ready',
            );
            const finalize =
              ready !== undefined &&
              !rows.some(
                (row) =>
                  row.type === 'response.finalized' &&
                  row.commit > ready.commit,
              );
            const replayed = yield* afterTextResponse(
              state,
              text,
              false,
              finalize,
            );
            state = replayed.state;
            if (replayed.done) return completeTurn(state);
            continue;
          }
        }
        const bound = yield* SynchronizedRef.get(run.model);
        // The step this request opens, its offered set recorded when changed.
        let step = yield* openStep(state, 'request');
        if (step.rows.length > 0) state = yield* cell.append(step.rows);
        let tools = toolDefinitionsFor(step.tools.definitions);
        // One round: the compaction the history may need, the snapshot that
        // admits the round, then the invocation. An open attempt's history
        // is fixed; it is neither compacted nor re-admitted.
        if (state.openAttempt === null) {
          const requested = compactionRequested;
          compactionRequested = false;
          state = yield* cell.adopt(
            yield* compaction.atBoundary(state, bound, requested),
          );
          // A compaction replaced the history, the context updates in it
          // too: a new step renders the system text anew, each one in it.
          if (state.offeredContext === null) {
            step = yield* openStep(state, 'request');
            state = yield* cell.append(step.rows);
            tools = toolDefinitionsFor(step.tools.definitions);
          }
          const admitted = snapshot(state, {});
          if (admitted.length > 0) state = yield* cell.append(admitted);
        }
        const toolChoice =
          forcedTool !== null && bound.supportsForcedToolChoice
            ? { name: forcedTool }
            : undefined;
        forcedTool = null;
        const outcome = yield* invoker.invoke(cell, {
          tools,
          toolChoice,
          system: step.system,
          // The model call this request is: the attempt row counts a new
          // one, a retry of the open attempt is the same call.
          round: state.openAttempt === null ? state.round + 1 : state.round,
          debugName: 'tooluse',
        });
        state = outcome.state;
        if (outcome.kind === 'cancelled') {
          return { state, outcome: 'cancelled' } as const;
        }
        if (outcome.kind === 'failed') {
          return { state, outcome: 'failed' } as const;
        }
        if (outcome.text) response = outcome.text;
        if (state.pendingResponse !== null) continue;
        // A text-only response: the same policy the resume path replays.
        const processed = yield* afterTextResponse(state, outcome.text, true);
        state = processed.state;
        if (!processed.done) continue;
        return completeTurn(state);
      }
    });
    return yield* stagedBy(
      () => logger.openStage('Tool-use turn', { kind: 'session' }),
      (exit: RunExit) => exit.outcome,
    )(body).pipe(
      Effect.ensuring(Effect.sync(() => workspace.workPlan.clearOnUpdate())),
    );
  });

  // ------------------------------------------------------------- the loop
  const enter = Effect.gen(function* () {
    // The follow-ups the rows still queue (input admitted while no consumer
    // held this run, or a batch a crash left unconsumed, C3) are the
    // publisher's, seeded where `loadRun`'s claim moved here.
    const entry = yield* loadRun(runId, start.resume);
    if (entry._tag === 'fresh')
      return yield* makeRunCell(runId, yield* openFresh(entry.opening));
    restore(entry.loaded);
    // The flag a `/compact` set died with the process; its request did not.
    // It is owed until a model boundary passed it: the boundary that runs
    // the compaction either replaces the view (the request goes with it)
    // or, when there is nothing to summarize, goes on to an attempt.
    if (owesCompaction(entry.loaded.messages.at(-1))) {
      const rows = yield* session.readAggregate(rowAggregate(runId), [
        'model.message',
      ]);
      const asked = rows.findLast(
        (row) =>
          row.type === 'model.message' &&
          row.payload.kind === 'append' &&
          owesCompaction(row.payload.messages.at(-1)),
      );
      compactionRequested =
        asked !== undefined &&
        !rows.some(
          (row) =>
            row.type === 'model.message' &&
            row.payload.kind === 'attempt' &&
            row.commit > asked.commit,
        );
    }
    return yield* makeRunCell(runId, entry.loaded);
  });

  const loopBody = (cell: RunCell) =>
    Effect.gen(function* () {
      let restoring = start.resume;
      for (;;) {
        let state = yield* cell.current;
        const parked =
          (state.phase === 'waiting' || state.phase === 'halted') &&
          state.at !== 'turn.ready';
        // The invoker commits the run's failure fact and the input that
        // recovers the run clears it, so the fold is the one place to read it.
        const afterError = state.lastError !== null;
        if (parked) {
          // A native child waits in this same run scope, just like its root:
          // its loop has already delivered the turn offered at the boundary.
          if (isChild() && afterError && !followUps.hasQueued())
            return finish(state, RUN_OUTCOME.FAILED);
          // Activation clears the visible step: restore an idle cursor's park.
          if (restoring && !followUps.hasQueued())
            state = yield* cell.append([positionRow(runId, state, 'waiting')]);
          restoring &&= followUps.hasQueued();
          // A child's idle is its parent's; the policy sees failed turns too.
          const canContinue =
            !run.toolPolicy.stopAfterCycle && !followUps.hasQueued();
          // A park opens a step, which pins (and records) its continuation.
          let next: string | null = null;
          if (!isChild()) {
            const step = yield* openStep(state, 'park');
            if (step.rows.length > 0) state = yield* cell.append(step.rows);
            if (step.continuation !== null) {
              next = yield* step.continuation
                .atIdle({ session, runId, state, canContinue })
                .pipe(Effect.provide(step.tools.services));
            }
          }
          // Every park is idle, a failed turn's too: a resume acks the first.
          run.callbacks.onIdle?.();
          if (run.toolPolicy.stopAfterCycle) {
            return finish(
              state,
              afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
            );
          }
          // A queued follow-up outranks the policy's synthetic turn.
          let batch: FollowUpBatch | null =
            next !== null && !followUps.hasQueued()
              ? { kind: 'synthetic', text: next }
              : null;
          if (batch === null) {
            // The host port stays attached: `/model`, `/compact` land here.
            batch = yield* followUps.wait;
            if (batch === null) {
              // The input ended under the parked loop: a cancellation.
              return finish(
                state,
                afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
              );
            }
          }
          // A reset or handoff replaces the view a background summary
          // was computed from: that summary lands, or stops, first.
          const consumed: ConsumedFollowUps = yield* followUps.consume(
            state,
            batch,
            batch.kind === 'edit'
              ? (at) => compaction.settle(at, 'the task is being reset')
              : undefined,
          );
          state = yield* cell.adopt(consumed.state);
          if (!consumed.turn) continue;
        }
        restoring = false;
        const turn: RunExit = yield* start.turns
          ? start.turns.turnPermit(runTurn(cell))
          : runTurn(cell);
        state = turn.state;
        if (turn.outcome === 'cancelled') {
          return finish(state, RUN_OUTCOME.CANCELLED);
        }
        // A summary the turn started lands before the turn ends.
        state = yield* cell.adopt(yield* compaction.finish(state));
        // The turn's trace rows publish fire-and-forget: settling this run's
        // publications (by run id) orders them before `waiting`. A failure
        // ends the run, the `artifact-drain` marker on its last row.
        yield* session.settlePublications(runId, { consume: false });
        // The turn boundary, in one batch: a completed turn's Stop hooks, the
        // snapshot, then the steps; `waiting` parks the run, so open streaming
        // rows close here. A child's turn the run goes on from settles here.
        const goesOn = script === null && !run.toolPolicy.stopAfterCycle;
        const settlement =
          start.turns && goesOn && turn.outcome === 'completed'
            ? yield* start.turns.settleBoundary(result(turn.outcome, state))
            : null;
        state = yield* cell.append([
          ...(yield* stopHooks(run, turn, response)),
          ...snapshot(state, {}),
          positionRow(runId, state, 'turn.end'),
          ...session.streamClosureFacts(runId),
          positionRow(runId, state, 'waiting'),
          ...(settlement?.rows ?? []),
        ]);
        if (turn.outcome === 'completed') {
          const interactions = workspace.interactions;
          const cost = state.usage.totalCost;
          run.callbacks.onProgress?.({
            kind: 'overview',
            toolCallCount: interactions.toolCallCount,
            filesChanged: interactions.editedFilePaths,
            cost: cost > 0 ? cost : undefined,
          });
        }
        if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
          return finish(state, turn.outcome);
        if (script !== null) return finish(state, turn.outcome);
        if (settlement !== null)
          yield* Effect.uninterruptible(settlement.settled);
      }
    });

  /** A run that ends here: its halt commits with its `run.end`. */
  const finish = (state: RunState, outcome: RunOutcome): RunExit =>
    ({ state, outcome }) as const;

  const result = (outcome: RunOutcome, at: RunState): ToolUseResult => ({
    outcome,
    response,
    files: workspace.interactions.toSnapshot().edits.map((e) => e.path),
    usage: at.usage,
    structured: run.structured.value,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { error: at.lastError }
      : {}),
  });

  // Attach inside the outer use so its release detaches even after a partial
  // attach failure. The inner bracket settles the cell before detachment;
  // `cell.append` protects each run history commit from interruption.
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        yield* Effect.sync(attach);
        return yield* Effect.acquireUseRelease(enter, loopBody, (cell, exit) =>
          // However the run ends, a stop's interruption included, a
          // finished summary lands before the halt (its usage is the
          // run's); one still running stops with the run.
          Effect.andThen(
            cell.current.pipe(
              Effect.flatMap((at) => compaction.settle(at, 'the run stopped')),
              Effect.flatMap(cell.adopt),
              Effect.catch((error) =>
                Effect.sync(() =>
                  logger.warn(
                    'A finished background compaction could not be recorded as the run stopped',
                    { data: error },
                  ),
                ),
              ),
            ),
            settleRun(cell, followUps)(exit),
          ),
        );
      }),
    () => Effect.sync(detach),
  ).pipe(
    Effect.map((loop) => result(loop.outcome, loop.state)),
    Effect.catchCause(stoppedBy(logger, `Tool-use run ${runId}`)),
  );
}, Effect.scoped);
