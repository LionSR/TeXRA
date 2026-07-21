// One driver for every child-run type (agent-CLI codex/claude sessions, native
// tool-use subagents, native workflow subagents). Each turn source supplies an
// AgentCliSessionStrategy-shaped ChildRunStrategy; this loop owns the parts
// that were previously duplicated per driver: follow-up queue acquire/drain,
// one run-handle interrupt target for the child's whole lifetime, per-turn
// delivery choreography (format → persist report → optional manifest → deliver
// with wake), and the terminal call into the shared finalizer.
//
// Host-agnostic, VS Code-free.

import { synchronizeAgentResultOutcome, type ResultMeta } from '@agent/storage';
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  markOwnedExecutionLeaseUndurable,
  onOwnedExecutionLeaseLost,
  runWithOwnedExecutionLease,
} from '@agent/storage/executionLease';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { finalizeRunTerminal } from '@agent/runtime/AgentRunLifecycle';
import { releaseExecutionLeaseAfterArtifacts } from '@agent/runtime/executionOwnership';
import type {
  AgentExecutionHandle,
  ExecutionInterruptHandler,
} from '@agent/runtime/ExecutionHandle';
import type { FollowUpQueue } from '@agent/followUp/FollowUpQueue';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { classifyAgentError } from '@common/errors';
import { isUserAbort } from '@common/errors/sdkErrorUtils';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';

import {
  enqueueChildRunFollowUp,
  wakeChildRunFollowUp,
  persistChildRunReport,
  persistChildRunResultMeta,
  type ChildRunEnqueueResult,
} from '@tools/childRunDelivery';
import { formatSubagentProgress } from '@tools/subagentResults';
import type { ChildStream, ChildStreamOutcome } from '@tools/childStream';
import { formatDuration } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Minimal token usage shape consumed by the loop's turn summary. */
type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Capabilities the loop provides to a strategy for the duration of one child
 * run. `notify` is best-effort live progress (no report/manifest persist, no
 * gating — duplicate delivery is impossible by construction since there is
 * one delivery site per turn, so there is nothing left to dedupe against).
 * `recordCost` may be called freely, as often as the strategy likes, with the
 * run's latest cumulative cost — the loop commits only the last value it saw,
 * exactly once, when the child's run ends (matching the "settle exactly once
 * with the best available total" contract `settleSubagentCost` used to own).
 */
export interface ChildRunPorts {
  notify(update: SubagentProgressUpdate): void;
  recordCost(totalCostUsd: number | undefined): void;
}

/**
 * Provider-specific behavior for a single child run. Created once per run;
 * its methods close over the provider's thread/session object, registry, and
 * runtime host.
 *
 * `launch` produces the first turn's outcome (agent-CLI: delegates to
 * `runTurn` with the seeded initial prompt; native: the `executeAgent`
 * call itself). `runTurn` produces every following turn's outcome, given the
 * follow-up items the loop drained since the previous turn (agent-CLI joins
 * their text into one prompt; native injects the already-consumed batch at
 * the resumed flow's persisted WAITING boundary without re-enqueueing it).
 *
 * Per-turn call order: `launch`/`runTurn` → `getUsage` (turn summary) →
 * `isTurnError` → `onTurnError` (if true) → `publishUsage` →
 * `formatDelivery`/`formatError` → `buildResultMeta` → `onTurnSuccess` (only
 * while the loop remains active) → route/wake the parent.
 * Failed turns release session ownership before routing/waking the parent;
 * interrupted turns release ownership but skip parent delivery entirely.
 */
export interface ChildRunStrategy<TTurn> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /** Produce the first turn's outcome. Throws on hard failure. */
  launch(
    ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<TTurn>;

  /**
   * Produce the next turn's outcome from the queued follow-up batch. Throws
   * on hard failure. Omitted by strategies whose first (and only) turn is
   * always terminal (native workflow) — the loop never calls `runTurn` in
   * that case, since it only continues past a non-terminal turn.
   */
  runTurn?(
    followUps: readonly FollowUpQueueBatchItem[],
    ports: ChildRunPorts,
    abortController: AbortController,
  ): Promise<TTurn>;

  /** True when `turn` ends this child's run — no further turns follow. */
  isTerminal(turn: TTurn): boolean;

  /** Token usage for the turn summary (null when none). */
  getUsage?(turn: TTurn): TurnUsage | null;

  /**
   * Application-level error reported by a turn that did NOT throw (e.g. the SDK
   * returned an error result). Omit for providers that always throw on failure.
   */
  isTurnError?(turn: TTurn): boolean;

  /** Log a turn-level error message for a non-throwing failure. */
  onTurnError?(turn: TTurn, logger: AgentTrace): void;

  /** After a successful turn: register the session/thread id, etc. */
  onTurnSuccess?(turn: TTurn, session: SessionHandle): void;

  /** Publish token usage to the UI. */
  publishUsage?(turn: TTurn): void;

  /**
   * Format the success delivery XML. Native workflow strategies compute this
   * asynchronously (diff files are written to the run directory first).
   */
  formatDelivery(turn: TTurn, wallTimeMs: number): string | Promise<string>;

  /** Format the error delivery XML (turn is null when the call threw). */
  formatError(turn: TTurn | null, err: unknown): string | Promise<string>;

  /**
   * Structured result manifest for a turn's delivery, persisted alongside the
   * report so `/executions/{id}/result` reflects the latest turn — called for
   * both success and failure (`turn` is null when the call threw, `isError`
   * is set for both a throw and a non-throwing application-level failure) so
   * a failure overwrites any earlier interim-success manifest instead of
   * leaving it stale. Native strategies provide one per turn; agent-CLI
   * strategies omit it — they have no chaining-manifest contract.
   */
  buildResultMeta?(
    turn: TTurn | null,
    isError: boolean,
    wallTimeMs: number,
  ): ResultMeta | undefined | Promise<ResultMeta | undefined>;

  /**
   * Where a turn's delivery should be sent. Defaults to the run's static
   * `parentStreamId` when omitted. Native strategies track the live run
   * handle's `deliveryTargetStreamId`, which goes `undefined` once the child
   * is detached from its orchestrator (see `AgentExecutionHandle.detach`), so
   * a detached child's results stop routing to the old parent.
   */
  resolveDeliveryTarget?(): StreamTabId | undefined;

  /**
   * Release provider-owned registry entries. The loop calls this exactly once,
   * before failed/interrupted parent delivery or during finalization.
   */
  releaseSessionOwnership?(): void;
}

export interface ChildRunLoopParams<TTurn> {
  /**
   * Presentation/lifecycle wrapper for agent-CLI child streams. Native
   * strategies omit this — `executeAgent`/`resumeToolUseFromResumeData`
   * already own handle creation, tracking, and terminal finalization for
   * every turn via `runFlowWithLifecycle`, so there is no separate stream tab
   * for this loop to finalize.
   */
  readonly childStream?: ChildStream;
  /**
   * The child's stream id, known deterministically upfront by every caller
   * (agent-CLI: `createChildStream`'s own id; native: `getStreamTabId` — the
   * same formula `buildAgentLaunchContext` derives internally) — never
   * discovered mid-flight, so the loop can acquire the follow-up queue and
   * attach its interrupt handler before the first turn ever runs when a handle
   * already exists.
   */
  readonly childStreamId: StreamTabId;
  readonly parentStreamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly strategy: ChildRunStrategy<TTurn>;
  /**
   * Roll this child's final cost into the parent's usage totals. Omitted by
   * agent-CLI callers (no cost concept today); native delegation passes its
   * captured `recordSubagentCost` closure.
   */
  readonly recordCost?: (totalCostUsd: number | undefined) => void;
}

/**
 * Interrupt handler attached to the child's execution handle for the child's
 * whole lifetime, so the stop button always finds a live target — including
 * the inter-turn WAITING gap, when no flow-owned context is attached.
 *
 * Does NOT implement the session duck-type (no `session.appendFollowUp`), so
 * flow-only commands such as context compaction ignore it. Follow-ups route
 * through the WAITING state queue path: `sendFollowUp()` → stream is WAITING →
 * `session.followUps.enqueue()`.
 *
 * `interrupt()` additionally delegates into a live native turn's flow
 * context, when one is currently attached. `handle.getToolUseFlow()` is the
 * one place a currently-running turn's real interrupt reaches.
 */
class ChildRunInterruptible implements ExecutionInterruptHandler {
  private interrupted = false;
  private queue: FollowUpQueue | null = null;
  private turnAbortController: AbortController | null = null;

  constructor(
    private readonly session: SessionHandle,
    private readonly childStreamId: StreamTabId,
  ) {}

  interrupt(): void {
    this.interrupted = true;
    this.queue?.cancelWait();
    this.turnAbortController?.abort();
    const handle = this.session.executions.getAgentHandleByStream(
      this.childStreamId,
    );
    handle?.getToolUseFlow()?.interrupt();
  }

  setQueue(q: FollowUpQueue): void {
    this.queue = q;
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  startTurn(): AbortController {
    this.turnAbortController = new AbortController();
    return this.turnAbortController;
  }

  finishTurn(): void {
    this.turnAbortController = null;
  }
}

/** True when an error/abort represents a clean, caller-initiated interruption. */
function isCleanInterruption(
  err: unknown,
  signal: AbortSignal,
  loop: ChildRunInterruptible,
): boolean {
  return signal.aborted || loop.isInterrupted() || isUserAbort(err);
}

/** Log a turn summary (duration + token usage) to the child stream. */
function logTurnSummary(
  logger: AgentTrace,
  wallTimeMs: number,
  usage: TurnUsage | null | undefined,
): void {
  logger.info(`Turn completed in ${formatDuration(wallTimeMs)}`);
  if (usage) {
    logger.info('Tokens', {
      data: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    });
  }
}

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn (via `runner`) and classify the outcome. A clean interruption
 * maps to `interrupted` (the caller breaks), a thrown call to `failed`, and a
 * returned turn to `completed` (carrying its application-level error flag).
 */
async function attemptTurn<TTurn>(
  strategy: ChildRunStrategy<TTurn>,
  runner: (abortController: AbortController) => Promise<TTurn>,
  loop: ChildRunInterruptible,
  logger: AgentTrace,
  abortController: AbortController,
  startedAt: number,
): Promise<TurnAttempt<TTurn>> {
  try {
    const turn = await runner(abortController);
    logTurnSummary(logger, Date.now() - startedAt, strategy.getUsage?.(turn));
    const turnIsError = strategy.isTurnError?.(turn) === true;
    if (turnIsError) {
      strategy.onTurnError?.(turn, logger);
    }
    return { kind: 'completed', turn, turnIsError };
  } catch (caught) {
    if (isCleanInterruption(caught, abortController.signal, loop)) {
      return { kind: 'interrupted' };
    }
    logger.error(toErrorMessage(caught));
    return { kind: 'failed', err: caught };
  } finally {
    loop.finishTurn();
  }
}

/**
 * Persist a turn report, swallowing storage errors. Best-effort — but the report
 * is the only durable copy of the result when delivery fails, so leave a trace.
 */
async function persistReportBestEffort(
  executionId: ExecutionId,
  msg: string,
  logger: AgentTrace,
): Promise<void> {
  const result = await persistChildRunReport(executionId, msg);
  if (result.kind === 'failed') {
    markOwnedExecutionLeaseUndurable(executionId);
    logger.warn(`Failed to persist report for ${executionId}`, {
      data: result.err,
    });
  }
}

/** Persist the optional structured result manifest. Best-effort. */
async function persistResultMetaBestEffort(
  executionId: ExecutionId,
  resultMeta: ResultMeta | undefined,
  logger: AgentTrace,
): Promise<void> {
  if (!resultMeta) return;
  const result = await persistChildRunResultMeta(executionId, resultMeta);
  if (result.kind === 'failed') {
    markOwnedExecutionLeaseUndurable(executionId);
    logger.warn(`Failed to persist result manifest for ${executionId}`, {
      data: result.err,
    });
  }
}

/**
 * A turn's parent-follow-up enqueue, still pending its wake step. Waking can
 * await the resumed parent's entire turn (`agentResume.tryResumeStream` → …
 * → `resumeToolUseFromResumeData`), so callers that are about to finalize this
 * child (terminal/failed turns) must resolve the wake only AFTER that
 * finalize completes — otherwise a resumed parent that immediately waits on
 * this still-RUNNING execution self-stalls (#8093). Callers that continue to
 * another turn (no finalize pending) may wake immediately.
 */
interface PendingChildDelivery {
  readonly targetStreamId: StreamTabId;
  readonly enqueueResult: ChildRunEnqueueResult;
}

/**
 * Format, persist, and enqueue one turn's outcome on the parent's follow-up
 * queue — the loop's single delivery site, shared by every interim and
 * terminal turn, every strategy. Returns the pending delivery for the caller
 * to wake via {@link wakePendingDelivery} once its own ordering allows it;
 * `undefined` when there is nothing to wake (detached child, or delivery
 * skipped by `prepareParentDelivery`).
 */
async function deliverTurn<TTurn>(params: {
  strategy: ChildRunStrategy<TTurn>;
  executionId: ExecutionId;
  parentStreamId: StreamTabId;
  session: SessionHandle;
  logger: AgentTrace;
  turn: TTurn | null;
  err: unknown;
  wallTimeMs: number;
  isError: boolean;
  prepareParentDelivery?: () => boolean;
}): Promise<PendingChildDelivery | undefined> {
  const {
    strategy,
    executionId,
    parentStreamId,
    session,
    logger,
    turn,
    err,
    wallTimeMs,
    isError,
    prepareParentDelivery,
  } = params;
  const delivered = turn != null && !isError;
  const msg = await (delivered
    ? strategy.formatDelivery(turn, wallTimeMs)
    : strategy.formatError(turn, err));
  // Called for both success and failure — a failure must overwrite any
  // earlier interim-success manifest, not leave it stale.
  const resultMeta = await strategy.buildResultMeta?.(
    turn,
    isError,
    wallTimeMs,
  );

  await persistReportBestEffort(executionId, msg, logger);
  await persistResultMetaBestEffort(executionId, resultMeta, logger);

  // A strategy without `resolveDeliveryTarget` (agent-CLI) always delivers to
  // the run's static parent. A strategy that HAS one (native) may return
  // `undefined` — meaning the child was detached from its orchestrator (see
  // `AgentExecutionHandle.detach`) — which must skip delivery entirely, not
  // silently fall back to the old parent.
  const targetStreamId = strategy.resolveDeliveryTarget
    ? strategy.resolveDeliveryTarget()
    : parentStreamId;
  if (!targetStreamId) {
    logger.warn(
      'Turn result not delivered: child was detached from its orchestrator. The result remains in the execution report.',
      { data: { executionId } },
    );
    return undefined;
  }
  if (prepareParentDelivery?.() === false) return undefined;
  const enqueueResult = await enqueueChildRunFollowUp({
    targetStreamId,
    followUp: { text: msg, origin: 'subagent_result' },
    session,
  });
  if (enqueueResult.kind === 'no_session') {
    logger.warn(
      'Turn result not delivered: parent stream has no active session. The result remains in the execution report.',
      {
        data: {
          executionId,
          parentStreamId: targetStreamId,
          streamStatus: enqueueResult.streamStatus ?? 'unknown',
        },
      },
    );
  }
  return { targetStreamId, enqueueResult };
}

/**
 * Resolve a pending delivery's wake step (no-op when there is nothing to
 * wake, or the enqueue itself found no session — already logged above).
 */
async function wakePendingDelivery(
  pending: PendingChildDelivery | undefined,
  session: SessionHandle,
  executionId: ExecutionId,
  logger: AgentTrace,
): Promise<void> {
  if (!pending || pending.enqueueResult.kind === 'no_session') return;
  const delivery = await wakeChildRunFollowUp(
    pending.targetStreamId,
    pending.enqueueResult,
    session,
  );
  if (delivery.kind === 'dropped') {
    logger.warn(
      'Turn result dropped: parent stream is gone and could not be resumed. The result remains in the execution report.',
      { data: { executionId, parentStreamId: pending.targetStreamId } },
    );
  }
}

/**
 * True when this session owns a live child-run loop for `streamId`. Enqueueing
 * into that loop's `FollowUpQueue` either wakes its pending wait or leaves the
 * item for its next wait boundary, so callers avoid racing a second host-level
 * resume. A genuine restart has no registered loop and still needs the generic
 * wake path.
 */
export function isChildRunLoopActive(streamId: StreamTabId): boolean {
  return currentSession().executions.isChildRunLoopActive(streamId);
}

/**
 * Drive a child run: the initial turn goes through `strategy.launch`, then
 * every following turn is drained from the child's follow-up queue and run
 * through `strategy.runTurn`. Each turn's result (or error) is delivered to
 * the parent's follow-up queue and persisted as a report; the run ends when a
 * turn is terminal, a turn fails, or the loop is interrupted.
 */
export function startChildRunLoop<TTurn>(
  params: ChildRunLoopParams<TTurn>,
): void {
  const {
    childStream,
    childStreamId,
    parentStreamId,
    executionId,
    agentName,
    strategy,
  } = params;
  // Agent-CLI children log to their own presentation stream; native children
  // have no stream tab of their own here (each turn already logs through its
  // own run trace inside `runFlowWithLifecycle`), so this is a channel-only
  // fallback for the loop's own turn-summary/warning lines.
  const logger = childStream?.logger ?? createChannelTrace('childRunLoop');
  // The code below is synchronous until the scoped loop task is spawned, so a
  // lost generation fails before any queue, listener, stage, or loop exists.
  runWithOwnedExecutionLease(executionId, () => undefined);

  const runSession = currentSession();
  const loop = new ChildRunInterruptible(runSession, childStreamId);
  const stopWatchingLease = onOwnedExecutionLeaseLost(executionId, () => {
    logger.error('Execution lease was lost; interrupting the former owner', {
      data: { executionId, childStreamId },
    });
    loop.interrupt();
  });
  const queue = runSession.followUps.acquire(childStreamId);
  loop.setQueue(queue);
  let attachedHandle: AgentExecutionHandle | undefined;
  let detachLoopInterrupt: (() => void) | undefined;
  const attachLoopInterrupt = (): void => {
    const handle = runSession.executions.getAgentHandleByStream(childStreamId);
    if (!handle || handle === attachedHandle) return;
    detachLoopInterrupt?.();
    attachedHandle = handle;
    detachLoopInterrupt = handle.attachInterruptHandler(loop);
  };
  attachLoopInterrupt();
  const unregisterChildRunLoop =
    runSession.executions.registerChildRunLoop(childStreamId);

  const sessionStage = childStream
    ? logger.openStage(strategy.stageLabel)
    : undefined;
  let sessionOwnershipReleased = false;
  const releaseSessionOwnershipOnce = (): void => {
    if (sessionOwnershipReleased) return;
    sessionOwnershipReleased = true;
    strategy.releaseSessionOwnership?.();
  };

  let latestCostUsd: number | undefined;
  const ports: ChildRunPorts = {
    notify: (update) => {
      const targetStreamId = strategy.resolveDeliveryTarget
        ? strategy.resolveDeliveryTarget()
        : parentStreamId;
      if (!targetStreamId) return; // Detached — see deliverTurn for the same guard.
      const msg = formatSubagentProgress(executionId, agentName, update);
      // Enqueue-only — intentional. A live progress notification should
      // never wake a WAITING/detached parent stream just to deliver an
      // interim update; only a turn's own delivery (deliverTurn, below)
      // wakes the parent.
      void enqueueChildRunFollowUp({
        targetStreamId,
        followUp: { text: msg, origin: 'subagent_result' },
        session: runSession,
      });
    },
    recordCost: (totalCostUsd) => {
      if (totalCostUsd !== undefined) latestCostUsd = totalCostUsd;
    },
  };

  let sawTurnFailure = false;
  let lastTurnErr: unknown;
  // A delivery whose wake is still pending. Set right before any `break` out
  // of the loop below (terminal/failed turn) and resolved AFTER this child's
  // own finalize in the `finally` block — never before — so a resumed parent
  // that immediately waits on this execution always finds it terminal
  // (#8093). Interim (non-terminal) turns wake inline, immediately, since no
  // finalize is pending for them.
  let pendingDelivery: PendingChildDelivery | undefined;
  void runWithOwnedExecutionLease(executionId, async () => {
    let runner: (ac: AbortController) => Promise<TTurn> = (ac) =>
      strategy.launch(ports, ac);
    try {
      while (!loop.isInterrupted()) {
        const startedAt = Date.now();
        const abortController = loop.startTurn();
        const attempt = await attemptTurn(
          strategy,
          runner,
          loop,
          logger,
          abortController,
          startedAt,
        );
        attachLoopInterrupt();
        if (attempt.kind === 'interrupted') break;

        const turn = attempt.kind === 'completed' ? attempt.turn : null;
        const err = attempt.kind === 'failed' ? attempt.err : null;
        const turnIsError =
          attempt.kind === 'completed' ? attempt.turnIsError : false;
        const wallTimeMs = Date.now() - startedAt;
        const turnFailed = err != null || turnIsError;

        if (turn != null) {
          strategy.publishUsage?.(turn);
        }

        const delivery = await deliverTurn({
          strategy,
          executionId,
          parentStreamId,
          session: runSession,
          logger,
          turn,
          err,
          wallTimeMs,
          isError: turnFailed,
          prepareParentDelivery: () => {
            if (loop.isInterrupted()) {
              releaseSessionOwnershipOnce();
              return false;
            }
            if (turnFailed) {
              releaseSessionOwnershipOnce();
            } else if (turn != null) {
              strategy.onTurnSuccess?.(turn, runSession);
            }
            return true;
          },
        });

        if (turnFailed) {
          sawTurnFailure = true;
          lastTurnErr =
            err ??
            new Error(
              `${strategy.stageLabel} reported a failed turn without throwing.`,
            );
          childStream?.failTurn();
          pendingDelivery = delivery;
          break;
        }

        const isTerminal = turn != null && strategy.isTerminal(turn);
        if (isTerminal || !strategy.runTurn) {
          // A strategy without `runTurn` (native workflow) declares every
          // turn terminal via `isTerminal`; reaching here with one still
          // undeclared-terminal is a strategy bug, not a run outcome — stop
          // rather than call an absent `runTurn`.
          pendingDelivery = delivery;
          break;
        }

        // Interim turn continuing: no finalize is pending, so wake now — the
        // loop's interrupt handler is already attached (immediately above,
        // the instant this turn settled) — then just drain the next batch. A
        // follow-up already raced into the queue resumes immediately instead
        // of genuinely waiting.
        await wakePendingDelivery(delivery, runSession, executionId, logger);
        childStream?.waitForInput();
        if (loop.isInterrupted()) break;

        const batch = await queue.waitAndDrainAll(() => loop.isInterrupted());
        if (!batch || loop.isInterrupted()) break;

        const nextRunTurn = strategy.runTurn;
        runner = (ac) => nextRunTurn(batch.items, ports, ac);
        childStream?.beginTurn();
      }
    } finally {
      detachLoopInterrupt?.();
      unregisterChildRunLoop();
      runSession.followUps.release(childStreamId);
      releaseSessionOwnershipOnce();
      try {
        params.recordCost?.(latestCostUsd);
        // The shared terminal finalizer owns the single outcome derivation and
        // its projections: persisted terminal status (before untrack notifies
        // waiters), settled result, and terminal stream phase.
        if (childStream) {
          // Agent-CLI: ChildStream.finalize owns this handle for the loop's
          // whole lifetime (one handle, tracked once by createChildStream).
          let loopOutcome: ChildStreamOutcome;
          if (loop.isInterrupted()) {
            loopOutcome = { kind: 'cancelled' };
          } else if (sawTurnFailure) {
            loopOutcome = { kind: 'failed' };
          } else {
            loopOutcome = { kind: 'completed' };
          }
          await childStream.finalize({
            outcome: loopOutcome,
            stage: sessionStage,
            persistence: { kind: 'finalize', flowRecord: 'delete' },
          });
        } else {
          // Native: every GENUINE terminal turn already finalized its own
          // handle inside runFlowWithLifecycle (the handle is untracked by the
          // time this runs, so the lookup below finds nothing — a safe no-op).
          // Two paths leave the most recently tracked handle for this stream
          // dangling, never finalized by its own flow:
          //   (1) the loop was interrupted between turns — ExecutionRegistry
          //       .terminate() found this loop's own interrupt handler, called
          //       .interrupt(), and transitioned the stream to CANCELLED, but
          //       assumed a live flow would notice and self-finalize; nothing
          //       is running here, the loop was just blocked on a queue wait.
          //   (2) `runTurn` threw before ever reaching a new
          //       runFlowWithLifecycle call (a resume pre-check failure, or a
          //       failed resume per #7491) — the prior turn's suspended handle
          //       was never touched by this attempt.
          // `finalizeRunTerminal`'s atomic claim makes this call safe even if
          // it races something else that already finalized the same handle.
          const handle =
            runSession.executions.getAgentHandleByStream(childStreamId);
          if (handle) {
            const outcome = deriveRunOutcome({
              failed: sawTurnFailure && !loop.isInterrupted(),
              cancelled: loop.isInterrupted(),
            });
            const finalized = await finalizeRunTerminal({
              handle,
              executions: runSession.executions,
              streamStatus: runSession.status,
              outcome,
              error:
                sawTurnFailure && lastTurnErr !== undefined
                  ? {
                      kind: classifyAgentError(lastTurnErr),
                      message: toErrorMessage(lastTurnErr),
                    }
                  : undefined,
              isSubagent: true,
              persistence: {
                kind: 'finalize',
                flowRecord:
                  outcome === RUN_OUTCOME.CANCELLED ? 'preserve' : 'delete',
              },
            });
            // No turn result follows an interruption between turns. Only this
            // path may relabel the latest interim envelope; ordinary terminal
            // turns persist their own result after runFlowWithLifecycle returns.
            if (finalized?.terminalStatusPersisted && loop.isInterrupted()) {
              await synchronizeAgentResultOutcome(executionId, outcome);
            }
          }
        }
        // Wake the parent only now — after this child's own finalize above —
        // so a resumed parent turn that immediately waits on this execution
        // (e.g. `executions` tool with `action=wait`) always observes it
        // terminal instead of racing its own wake (#8093).
        await wakePendingDelivery(
          pendingDelivery,
          runSession,
          executionId,
          logger,
        );
      } finally {
        try {
          await releaseExecutionLeaseAfterArtifacts(runSession, executionId);
        } catch (error) {
          logger.warn('Failed to persist final child-run artifacts', {
            data: { executionId, error },
          });
        } finally {
          stopWatchingLease();
        }
      }
    }
  });
}
