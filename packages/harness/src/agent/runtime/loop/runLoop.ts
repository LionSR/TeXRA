/**
 * The tool-use program: one plain Effect loop over the run history, no cursor
 * and no graph. Durable phases are row data; the loop never holds its own
 * copy of the conversation, it continues from the state its run cell folds
 * back from every batch, which makes the live path and the resume path the
 * same function. Every write point below is one `cell.append`.
 *
 * The write points, in order: the opening batch of a fresh run (its message
 * and input, its `run.config` binding, `turn.ready`); `turn.begin`; per round
 * the invoker's `attempt` / `response` rows; per barrier call
 * its `tool.intent`; per finished call its `tool.result` with its card; the
 * delivering `append` with the complete tool group; a follow-up consumed at a
 * request or a nudge, each an `append`; `turn.end` and `waiting`; the
 * follow-up consumption; and the `run.end` at every exit that ends the
 * run. Every branch reads the fold: a run `waiting` re-enters the wait (a
 * batch consumed at `turn.ready` runs its turn), an unanswered open attempt
 * invokes again under its gate, a pending response dispatches what is
 * unfinished, a committed text response runs its policy, and a run whose turn
 * ended (`turn.end`) launched again waits for its input.
 *
 * A run opened on a script (`AgentConfig.script`: a background script, a
 * plugin's program) opens on that one call, handed down in its opening batch
 * instead of asked of its model; `RunState.handedDown` ends the turn.
 */

import { Context, Effect, Exit, type Scope, ScopedRef } from 'effect';

import { buildOpeningSystemPrompt } from '@agent/prompt/PromptBuilder';
import { getDisplayedInstruction } from '@agent/runtime/sessionDescription';
import { logUserMessage } from '@agent/trace/traceLogs';
import { LaunchRefused } from '@common/errors/agentErrors';
import { sourceLocationUnder } from '@common/storage/storageLayout';
import {
  type BoundModel,
  ModelAccess,
} from '@agent/runtime/modelAccess/ModelAccess';
import { Inbox } from '@agent/followUp/Inbox';
import { activationRows, RunOpenRejected } from '@agent/storage/runLifecycle';
import { SessionRoots } from '@platform/rootedFs';
import {
  type CommitOrdinal,
  type MediaAttachmentKind,
  outcomeFromCause,
  RUN_OUTCOME,
  type RunId,
  type SessionRowDraft,
  type RunOutcome,
} from '@shared/schemas';
import {
  Approvals,
  RunHistory,
  RunHistoryRefused,
  SessionLog,
  type RunCell,
} from '@shared/session/runHistory';
import { isResuming, type RunState } from '@shared/session/runState';
import { turnText } from '@shared/session/runFacts';
import { skillActivationText } from '@skills/runtimeSkills';
import { sentDefinitions } from '@tools/catalogEntries';
import { sha256 } from '@utils/core/idHash';

import { AgentRun } from '../run/AgentRun';
import { compactAfterOverflow, compactAtBoundary } from '../run/compaction';
import { mediaInputParts } from '../run/mediaInput';
import type { InputPart } from '@texra-ai/llm';
import { claimFollowUps, type FollowUps } from '../FollowUps';
import { ModelInvoker } from '../ModelInvoker';
import { scriptCallOf } from '../programRun';
import { resumeLeftoverChildren } from '../leftoverChildren';
import {
  appendRow,
  configRow,
  consumedRows,
  handedDown,
  finalizedRows,
  positionRow,
} from './rows';
import { dispatchPendingResponse } from './toolUseDispatch';
import { hooksOf } from './hooks';
import { dispatchTools, stepFor } from './step';
import { applyPendingModelSwitch, modelSwitchPort } from './modelSwitch';
import { RunRegistry, type AgentRunServices } from '../runRegistry';
import type { RunControls } from '../runs';
import type { RunReport } from '../runReport';

const BLANK_TOOL_RESULT_CONTINUATION =
  'The previous assistant turn after a tool result was blank. Continue now with the final answer or next required action.';
const FINAL_TOOL_INSTRUCTION = 'Submit the final structured output now.';

/** What {@link openToolUse} committed: the run's cell and the commit of
 *  the batch that opened this activation. */
export interface ToolUseOpening {
  readonly cell: RunCell;
  readonly activation: CommitOrdinal;
}

/** A user message the loop appends itself. */
const nudge = (text: string) => ({
  role: 'user' as const,
  content: [{ kind: 'text' as const, text }],
});

/** A failed handed-down call answers with its error and a script that
 *  returned text with that text; otherwise the turn's response rows supply
 *  its answer, including after a resume. */
const turnResponse = ({ handedDown, answer }: RunState): string => {
  if (handedDown?.status === 'error') return handedDown.error;
  return typeof handedDown?.value === 'string' ? handedDown.value : answer;
};

/** What a resume's activation rows read of the session. */
type ActivationServices = SessionLog | SessionRoots | Approvals | RunRegistry;

/** Why a run its rows never opened cannot be continued. */
const NOT_RESUMABLE_MESSAGE =
  'This run stopped before it recorded any state to resume from. Start a new run instead.';

/**
 * The refusal of a resume of `runId` from `state`, or null when none is due:
 * a turn the next request replays (an assistant message, the pending
 * response's, or the continuation) was recorded on another protocol than
 * `bound` speaks now, so its provider evidence cannot be sent.
 */
const foreignProtocol = (
  runId: RunId,
  state: RunState,
  bound: Pick<BoundModel, 'backend' | 'origin'>,
): RunHistoryRefused | null => {
  const { pendingResponse, continuation } = state;
  const recorded = [
    ...[
      ...state.messages,
      ...(pendingResponse === null ? [] : [pendingResponse.assistant]),
    ].flatMap((message) =>
      message.role === 'assistant' && message.origin !== null
        ? [message.origin.protocol]
        : [],
    ),
    ...(continuation === null ? [] : [continuation.origin.protocol]),
  ].find((protocol) => protocol !== bound.origin.protocol);
  if (recorded === undefined) return null;
  return new RunHistoryRefused({
    reason: 'foreign-protocol',
    runId,
    detail: `its turns were recorded on ${recorded}, and its ${bound.backend} backend now binds ${bound.origin.protocol}`,
  });
};

/**
 * The run's entry: its cell. A fresh run's registration rides the cell's
 * first append, its opening, so the run exists with its opening or not at
 * all. A resume commits its activation, in one batch, and is refused when
 * the rows hold nothing to continue from. A fresh launch onto a run that
 * already holds history state is refused.
 * The caller opens a cell whose state has no position.
 */
const openRun = Effect.fn('toolUse.openRun')(function* (
  runId: RunId,
): Effect.fn.Return<
  RunCell,
  Error,
  RunHistory | AgentRun | ActivationServices
> {
  const runHistory = yield* RunHistory;
  const run = yield* AgentRun;
  // A launch with no registration is a resume.
  const { registration } = run.entry;
  const resume = registration === null;
  // The activation's rows are read in its publisher job, outside this fiber.
  const owners = Context.pick(
    SessionLog,
    SessionRoots,
    Approvals,
  )(yield* Effect.context<ActivationServices>());
  const runs = yield* RunRegistry;
  const opened = runHistory.open(
    runId,
    resume
      ? {
          activation: Effect.fn('activation')(function* (
            state: RunState | null,
          ) {
            if (state?.at == null)
              return yield* new RunOpenRejected({
                message: NOT_RESUMABLE_MESSAGE,
              });
            const refused = foreignProtocol(
              runId,
              state,
              yield* ScopedRef.get(run.model),
            );
            if (refused !== null) return yield* refused;
            const rows = yield* activationRows(runId, run.config).pipe(
              Effect.provide(owners),
            );
            // Each answer a person gave while no process held the run, for a
            // request still open: after the `run.activate`, so the call that
            // asked reads it as not yet seen and takes it (`resumedAttempt`).
            const answered: SessionRowDraft[] = [];
            for (const [requestId, decision] of runs.heldAnswers(runId)) {
              runs.dropAnswer(runId, requestId);
              if (state.requests[requestId]?.decision !== null) continue;
              answered.push({
                type: 'request.decided',
                aggregateId: runId,
                requestId,
                decision,
              });
            }
            return [...rows, ...answered];
          }),
        }
      : {
          registration: Effect.succeed(registration.rows),
        },
  );
  // A resume enters with its activation, with no alongside: its held
  // trace publishes once the activation commits. A fresh run enters with
  // its opening batch later (`openToolUse`); a stop lands before or after.
  const cell = yield* resume
    ? run.entry.enter(() => opened)
    : Effect.uninterruptible(opened);
  if (!resume && (yield* cell.current).at !== null)
    return yield* new RunOpenRejected({
      message: `Run ${runId} already has run history state; resume it instead.`,
    });
  return cell;
});

/** What a run program, and each of its turns, returns. */
type RunExit = {
  readonly state: RunState;
  readonly outcome: RunOutcome;
};

/**
 * The exit protocol, run at every exit of the loop (`Effect.onExit` in
 * {@link runToolUse}): the run's input lease, where it holds one. The halt is not written here:
 * it commits with the run's `run.end` (`endRunRows`), so no reader ever
 * sees a stopped run without its end.
 */
const finishRun =
  (
    cell: RunCell,
    /** The run's own input lease. */
    lease: FollowUps,
  ) =>
  (
    exit: Exit.Exit<RunExit, Error>,
  ): Effect.Effect<void, never, RunRegistry> => {
    // The body's own value when it returned.
    const outcome = Exit.match(exit, {
      onSuccess: (value) => value.outcome,
      onFailure: outcomeFromCause,
    });
    return Effect.flatMap(RunRegistry, (runs) =>
      Effect.map(runs.hasLiveDescendants(cell.runId), (descendants) =>
        lease.release(
          outcome === RUN_OUTCOME.COMPLETED && !descendants
            ? 'terminal'
            : 'recoverable',
        ),
      ),
    );
  };

/** What a turn of the loop reads from its run's context. */
type TurnServices = AgentRun | AgentRunServices | ModelAccess;

/**
 * The policy a committed text-only response runs: a blank turn after a tool
 * result (a message delivered at the request may sit between them) asks once
 * more, the terminal tool gets one forced turn per turn, else the turn ends
 * with this text. Each step is a row (a resume finds it); `done` ends the turn.
 */
const afterTextResponse = Effect.fn('toolUse.afterTextResponse')(function* (
  cell: RunCell,
  at: RunState,
  text: string,
): Effect.fn.Return<
  { readonly state: RunState; readonly done: boolean },
  Error,
  AgentRun | RunHistory
> {
  const { runId, finalToolName } = yield* AgentRun;
  if (
    !text.trim() &&
    at.messages.slice(0, -1).findLast((m) => m.role !== 'user')?.role === 'tool'
  ) {
    const row = appendRow(runId, [nudge(BLANK_TOOL_RESULT_CONTINUATION)], {
      reason: 'blank-continuation',
    });
    return { state: yield* cell.append([row]), done: false };
  }
  if (text && !at.answerFinalized)
    at = yield* cell.append(finalizedRows(runId, text, at.lastTurn));
  if (
    finalToolName !== null &&
    at.finalTool?.turn !== at.turn &&
    at.structured === null
  ) {
    const row = appendRow(runId, [nudge(FINAL_TOOL_INSTRUCTION)], {
      reason: 'final-tool',
    });
    return { state: yield* cell.append([row]), done: false };
  }
  return { state: at, done: true };
});

/**
 * Open the run's cell and commit what opens it, as the run's fiber opens
 * the run: a fresh run's opening batch (its registration, its prompt, its
 * first step), a fork's history, or a resume's activation. The loop
 * ({@link runToolUse}) then runs over what this answered.
 */
export const openToolUse = Effect.fn('toolUse.open')(
  function* (): Effect.fn.Return<ToolUseOpening, Error, TurnServices> {
    const run = yield* AgentRun;
    const { runId, logger } = run;
    const roots = yield* SessionRoots;
    // The system text a fresh run renders, until its opening batch records it.
    let openingSystem: string | undefined;
    const cell = yield* openRun(runId);
    const loaded = yield* cell.current;
    if (loaded.at !== null) {
      logger.debug('Resuming tool-use run from the run history.');
      return { cell, activation: cell.opened.commit };
    }
    // A fresh run's transcript opens with the user's instruction, with the
    // kinds of the media its opening inserts (a conversation's; a fork's
    // history or a script's call inserts none).
    const echo = (attachments: readonly MediaAttachmentKind[] = []) => {
      const text = getDisplayedInstruction(run.config);
      if (text) logUserMessage(logger, text, { attachments });
    };
    const bound = yield* ScopedRef.get(run.model);
    // The state its first step opens on: what the opening batch records.
    const { backend, declinedRoutes } = bound;
    const binding = { backend, declinedRoutes };
    const opening: RunState = {
      ...(yield* cell.current),
      ...{ modelId: bound.modelId, ...binding },
    };
    // A fork is born on the history it was cut from, its turn ready.
    const { seed } = run.entry;
    if (seed != null) {
      echo();
      const born = [
        ...seed.rows,
        configRow(runId, run.config, bound.modelId, binding),
        positionRow(runId, opening, 'turn.ready'),
      ];
      const state = yield* run.entry.enter((alongside) =>
        cell.append(born, alongside),
      );
      run.callbacks.onProgress?.({ kind: 'started' });
      return { cell, activation: state.commit };
    }
    // Keep preparation interruptible inside the masked acquire.
    const { content, offered, handed } = yield* Effect.interruptible(
      Effect.gen(function* () {
        // A script's run renders no prompt: what it runs is its call.
        const script = yield* scriptCallOf(run.config);
        if (script !== null) {
          echo();
          const step = yield* stepFor(run, opening, false);
          const content: InputPart[] = [
            { kind: 'text', text: `Run the script "${script.title}".` },
          ];
          const handed = [yield* handedDown(run, script)];
          return { content, offered: step.rows, handed };
        }
        const inputs =
          run.opening ?? (yield* Effect.die(new Error(`${runId}: no opening`)));
        // The first step renders the prompt over the tools it offers, and
        // stores its base text.
        const step = yield* stepFor(run, opening, false, (offered) =>
          buildOpeningSystemPrompt(run.persona.prompt, inputs, {
            roots,
            textOnly: bound.textOnly,
            offered,
          }),
        );
        openingSystem = step.base;
        // The user's task is the user message.
        const userRequest = run.config.instruction.trim();
        if (!userRequest)
          return yield* new RunOpenRejected({
            message: 'A conversation requires a non-empty task.',
          });
        // The skills its user activated lead it, each as its activation block.
        const skills = run.config.skills ?? [];
        const request =
          skills.length === 0
            ? userRequest
            : yield* skillActivationText(roots, skills, userRequest).pipe(
                Effect.catchTag('Rejected', ({ reason }) =>
                  Effect.fail(new LaunchRefused({ message: reason })),
                ),
              );
        const content: InputPart[] = [];
        const media = yield* Effect.exit(
          run.config.mediaFiles.length
            ? mediaInputParts(
                run.config.mediaFiles.map((p) => sourceLocationUnder(roots, p)),
                bound.config.capabilities,
                roots.config,
              )
            : Effect.succeed({ parts: [], kinds: [] }),
        );
        echo(Exit.isSuccess(media) ? media.value.kinds : []);
        if (Exit.isFailure(media)) return yield* Effect.failCause(media.cause);
        content.push(...media.value.parts, { kind: 'text', text: request });
        const hooked = yield* step.tools.hooks.opening(opening, request);
        content.push(...hooked.parts);
        return { content, offered: [...step.rows, ...hooked.rows], handed: [] };
      }),
    );
    const { activated = [], attachedMemoryMisses: misses = [] } =
      run.opening ?? {};
    const input = {
      ...(openingSystem !== undefined && { system: sha256(openingSystem) }),
      ...(activated.length > 0 && { activated: [...activated] }),
      ...(misses.length > 0 && { memoryMisses: misses }),
    };
    // The opening (registration, held trace), then the entry once it
    // finished: a stop lands before the opening or after both.
    const rows = [
      appendRow(runId, [{ role: 'user', content }], { input }),
      ...offered,
      configRow(runId, run.config, bound.modelId, binding),
      positionRow(runId, opening, 'turn.ready'),
      ...handed,
    ];
    const state = yield* run.entry.enter((alongside) =>
      cell.append(rows, alongside),
    );
    run.callbacks.onProgress?.({ kind: 'started' });
    return { cell, activation: state.commit };
  },
);

export const runToolUse = Effect.fn('toolUse.run')(function* (
  opened: ToolUseOpening,
): Effect.fn.Return<
  RunReport,
  Error,
  TurnServices | ModelInvoker | Scope.Scope
> {
  const run = yield* AgentRun;
  const invoker = yield* ModelInvoker;
  const access = yield* ModelAccess;
  const { runId, logger } = run;
  const log = yield* SessionLog;
  const roots = yield* SessionRoots;
  const isChild = () => run.entry.parent !== null;
  // A conversation claims its own input lease, never a parent's (FollowUps).
  const followUps = yield* claimFollowUps(run);

  // ---------------------------------------------------------------- state
  const { cell } = opened;
  /** What a compaction of this run reads, but its request's binding. */
  const compaction = { runId, logger, invoker, cell, stores: roots };

  // ------------------------------------------------------------ host port
  const controls: RunControls = modelSwitchPort(
    run,
    access,
    yield* Inbox,
    cell,
  );

  /** A turn's exit, and a handed-down call's run's at its park: a failed
   *  call's error fails it and is the reply (`turnResponse`). */
  const completeTurn = (at: RunState): RunExit => ({
    state: at,
    outcome: at.handedDown?.status === 'error' ? 'failed' : 'completed',
  });

  /** A handed-down call asks no model, and a delivered result may end the
   *  turn: either way its delivery ends it. */
  const turnEnded = (at: RunState) =>
    at.handedDown !== null || at.at === 'results.final';

  // ------------------------------------------------------------ the turn
  const runTurn = Effect.fn('toolUse.turn')(function* (
    cell: RunCell,
  ): Effect.fn.Return<RunExit, Error, TurnServices> {
    let state = yield* cell.current;
    // A turn begins at a finished boundary; a resumed one where its rows left.
    const begins =
      state.at === 'turn.ready' ||
      state.at === 'waiting' ||
      state.at === 'turn.end';
    if (begins) {
      state = yield* cell.append([
        positionRow(runId, { ...state, turn: state.turn + 1 }, 'turn.begin'),
      ]);
    }
    for (;;) {
      // The step's one reading of the run's input: a row queued after it is
      // the next step's.
      const input = yield* followUps.reader.read;
      state = yield* applyPendingModelSwitch(cell, input.controls);
      if (state.pendingResponse !== null) {
        // Input queued meanwhile is delivered at the request that follows.
        state = yield* dispatchPendingResponse(
          cell,
          yield* dispatchTools(run, state),
        );
        // Ended here, before the next step applies a queued model switch.
        if (turnEnded(state)) return completeTurn(state);
        continue;
      }
      // A resume that finds the delivery committed and the turn's end not.
      if (turnEnded(state)) return completeTurn(state);
      // A committed text-only response whose policy has not run: the
      // response this turn just received, or one a resume finds.
      const last =
        state.at === 'response.ready' && state.invocation === null
          ? state.messages.at(-1)
          : undefined;
      if (last?.role === 'assistant') {
        const text = turnText(last);
        const processed = yield* afterTextResponse(cell, state, text);
        state = processed.state;
        if (processed.done) return completeTurn(state);
        continue;
      }
      const bound = yield* ScopedRef.get(run.model);
      // A message typed while the turn ran joins the request after the tool
      // results (past a context update), never a user message: read before
      // the step opens, so a skill it activates is the step's, and before
      // the boundary's compaction, whose summary then covers it.
      const tail = state.messages.findLast((m) => m.role !== 'system');
      if (state.invocation === null && tail?.role === 'tool') {
        const queued = input.batch('request');
        if (queued !== null)
          state = yield* followUps.consume(cell, queued, {
            position: false,
          });
      }
      // The step this request opens, its offered set recorded when changed.
      let step = yield* stepFor(run, state, false);
      if (step.rows.length > 0) state = yield* cell.append(step.rows);
      let tools = sentDefinitions(step.tools);
      // One round: the compaction the history may need, the `/compact`s
      // it answers, the invocation. An open attempt's history is fixed.
      if (state.invocation === null) {
        // A `/compact`: the edit answering it applies it, else it is a no-op.
        const compacts = consumedRows(runId, 'compact');
        const requests = compacts(input.controls, { kind: 'applied' });
        const before = state.commit;
        state = yield* compactAtBoundary({ ...compaction, bound }, requests);
        // A compaction dropped the context updates: a new step renders them.
        if (state.offeredContext === null) {
          step = yield* stepFor(run, state, false);
          state = yield* cell.append(step.rows);
          tools = sentDefinitions(step.tools);
        }
        // No edit landed (a history too short to summarize, a summary that
        // failed): the `/compact`s it would have answered are no-ops.
        if (requests.length > 0 && state.commit === before)
          state = yield* cell.append(
            compacts(input.controls, { kind: 'dropped', reason: 'noop' }),
          );
      }
      const toolChoice =
        state.finalTool?.owed === true &&
        state.finalTool.turn === state.turn &&
        run.finalToolName !== null &&
        bound.forcedToolChoice
          ? { name: run.finalToolName }
          : undefined;
      const outcome = yield* invoker.invoke(cell, {
        tools,
        toolChoice,
        system: step.system,
      });
      state = outcome.state;
      if (outcome.kind === 'cancelled')
        return { state, outcome: 'cancelled' } as const;
      if (outcome.kind !== 'failed') continue;
      const compacted = yield* compactAfterOverflow({ ...compaction, bound });
      if (compacted === null) return { state, outcome: 'failed' } as const;
      state = compacted;
    }
  });

  // ------------------------------------------------------------- the loop
  const loopBody = Effect.fn('loopBody')(function* (cell: RunCell) {
    // A resumed run first finishes what its children were left as.
    if (run.entry.registration === null) yield* resumeLeftoverChildren();
    for (;;) {
      let state = yield* cell.current;
      const waiting = state.at === 'waiting' || state.at === 'turn.end';
      // The invoker commits the run's failure fact and the input that
      // recovers the run clears it, so the fold is the one place to read it.
      const afterError = state.lastError !== null;
      if (waiting) {
        if (state.handedDown !== null) return completeTurn(state);
        // A native child waits in this same run scope, just like its root:
        // its loop has already delivered the turn offered at the boundary.
        const input = yield* followUps.reader.read;
        const queued = input.pending('idle');
        if (isChild() && afterError && !queued)
          return { state, outcome: RUN_OUTCOME.FAILED };
        // An activation clears the step the view shows: a park it found
        // idle is written again, unless the queued input starts a turn.
        if (isResuming(state) && !queued)
          state = yield* cell.append([positionRow(runId, state, 'waiting')]);
        // A root's wait opens a step, recorded like a request's; a
        // child's idle is its parent's.
        if (!isChild()) {
          const step = yield* stepFor(run, state, true);
          if (step.rows.length > 0) state = yield* cell.append(step.rows);
        }
        // A one-shot run ends at its park, unless a message queued for it
        // starts its cycle: a child resumed for its parent's message.
        if (run.toolPolicy.stopAfterCycle && !queued) {
          return {
            state,
            outcome: afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.COMPLETED,
          };
        }
        // The host port stays attached: `/model`, `/compact` land here.
        const batch = yield* followUps.reader.next('idle', input);
        if (batch === null) {
          // The input ended under the waiting loop: a cancellation.
          return {
            state,
            outcome: afterError ? RUN_OUTCOME.FAILED : RUN_OUTCOME.CANCELLED,
          };
        }
        yield* followUps.consume(cell, batch);
      }
      const turn: RunExit = yield* runTurn(cell);
      state = turn.state;
      if (turn.outcome === 'cancelled') {
        return { state, outcome: RUN_OUTCOME.CANCELLED };
      }
      // The turn boundary, in one batch: Stop hooks, the steps (`waiting`
      // closes open streams), and a Stop hook's block or input already
      // queued.
      const reply = turnResponse(turn.state);
      const { rows: hooks, block } = yield* (yield* hooksOf(run)).stop(
        turn,
        reply,
      );
      const goesOn =
        !run.toolPolicy.stopAfterCycle && turn.outcome === 'completed';
      const ending = [
        positionRow(runId, state, 'turn.end'),
        ...log.closure(runId),
        positionRow(runId, state, 'waiting'),
      ];
      const next =
        block ?? (goesOn ? (yield* followUps.reader.read).batch('turn') : null);
      const pin =
        next !== null && !isChild() ? yield* stepFor(run, state, true) : null;
      state =
        next === null
          ? yield* cell.append([...hooks, ...ending])
          : yield* followUps.consume(cell, next, {
              rows: [...hooks, ...ending, ...(pin?.rows ?? [])],
            });
      if (turn.outcome === 'completed') {
        const cost = state.usage.cost;
        run.callbacks.onProgress?.({
          kind: 'overview',
          toolCallCount: state.toolCalls,
          filesChanged: [...state.edited],
          cost: cost > 0 ? cost : undefined,
        });
      }
      if (block !== null) continue;
      // A one-shot run ends with its completed turn; a handed-down call's
      // run ends at its park, however its turn ended.
      if (run.toolPolicy.stopAfterCycle && turn.outcome === 'completed')
        return { state, outcome: turn.outcome };
    }
  });

  /** The run's report: what it answered and edited, and its failure. */
  const result = (outcome: RunOutcome, at: RunState): RunReport => ({
    outcome,
    output: {
      response: turnResponse(at),
      files: [...at.edited],
      // A program's return value, which its registration reads (`Program.result`).
      ...(at.structured?.value !== undefined && {
        structured: at.structured.value,
      }),
    },
    runId,
    ...(outcome === RUN_OUTCOME.FAILED && at.lastError !== null
      ? { failure: { kind: 'model' as const, failure: at.lastError } }
      : {}),
    ...(at.input.memoryMisses?.length
      ? { memoryMisses: [...at.input.memoryMisses] }
      : {}),
  });

  // The controls detach as the run's scope closes, after the bracket below
  // finishes the cell; `cell.append` protects each commit from interruption.
  yield* (yield* RunRegistry).attachControls(runId, controls);
  return yield* loopBody(cell).pipe(
    Effect.onExit(finishRun(cell, followUps)),
    Effect.map((loop) => result(loop.outcome, loop.state)),
  );
}, Effect.scoped);
