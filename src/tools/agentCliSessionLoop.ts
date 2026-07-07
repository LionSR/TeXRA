// Shared session-loop runner for the agent-CLI tool modules (codex.ts,
// claudeAgent.ts). Both tools spin off an external CLI agent and then drive an
// identical turn loop: drain the child's follow-up queue, run one streamed turn
// per batch, deliver each result to the parent's follow-up queue, and finalize
// on interruption or failure. The provider-specific pieces (how a turn runs,
// how usage/results are formatted, which registry the session id lives in) are
// supplied via an AgentCliSessionStrategy so the subtle interrupt/finalize
// choreography lives in exactly one place.
//
// Host-agnostic, VS Code-free.

import type { AgentTrace } from '@agent/trace';
import { type IInterruptible } from '@agent/runtime/InterruptRegistry';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { FollowUpQueue } from '@agent/followUp/FollowUpQueue';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { isCleanInterruption, logTurnSummary } from './agentCliShared';
import {
  deliverChildRunFollowUp,
  persistChildRunReport,
} from './childRunDelivery';
import type { ChildStream } from './childStream';

/** Minimal token usage shape consumed by the loop's turn summary. */
type TurnUsage = { input_tokens?: number; output_tokens?: number };

/**
 * Lightweight interruptible registered with the InterruptRegistry so the stop
 * button works on agent-CLI child streams.
 *
 * Does NOT implement the session duck-type (no `session.appendFollowUp`), so
 * flow-only commands such as context compaction ignore it. Follow-ups route
 * through the WAITING state queue path: `sendFollowUp()` → stream is WAITING →
 * `session.followUps.enqueue()`.
 */
class AgentCliSession implements IInterruptible {
  private interrupted = false;
  private queue: FollowUpQueue | null = null;
  private turnAbortController: AbortController | null = null;

  interrupt(): void {
    this.interrupted = true;
    this.queue?.cancelWait();
    this.turnAbortController?.abort();
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

/**
 * Provider-specific behavior for a single agent-CLI session. Created once per
 * session; its methods close over the provider's thread/session object,
 * registry, and runtime host.
 *
 * Per-turn call order inside the loop:
 *   runTurn → getUsage (turn summary) → isTurnError → onTurnError (if true)
 *   → onTurnSuccess (only when the turn did not fail) → publishUsage → format*.
 * `onTurnError` fires only for a non-throwing turn that reports an
 * application-level error (`isTurnError` true); a thrown turn goes through the
 * loop's catch instead and is formatted via `formatError(null, …)`.
 * `onSessionStart` runs once before the first turn; `onSessionCleanup` runs once
 * in the loop's `finally`. `publishUsage` owns its own usage-presence check.
 */
export interface AgentCliSessionStrategy<TTurn> {
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  readonly stageLabel: string;

  /**
   * Called once before the loop starts. Used to register a resumed session id
   * immediately so a concurrent call with the same id can't start a second loop.
   */
  onSessionStart?(session: SessionHandle): void;

  /** Run one streamed turn. Throws on hard failure. */
  runTurn(prompt: string, abortController: AbortController): Promise<TTurn>;

  /** Token usage for the turn summary (null when none). */
  getUsage(turn: TTurn): TurnUsage | null;

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
  publishUsage(turn: TTurn): void;

  /** Format the success delivery XML. */
  formatDelivery(turn: TTurn, prompt: string, wallTimeMs: number): string;

  /** Format the error delivery XML (turn is null when `runTurn` threw). */
  formatError(turn: TTurn | null, prompt: string, err: unknown): string;

  /**
   * Called in the finally block to release provider-owned registry entries.
   * Runs after this loop unregisters its interrupt and follow-up queue state.
   */
  onSessionCleanup?(): void;
}

export interface RunAgentCliSessionParams<TTurn> {
  childStream: ChildStream;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
  initialPrompt: string;
  strategy: AgentCliSessionStrategy<TTurn>;
}

/** Outcome of a single turn attempt, flattening the loop's inner try/catch. */
type TurnAttempt<TTurn> =
  | { kind: 'completed'; turn: TTurn; turnIsError: boolean }
  | { kind: 'failed'; err: unknown }
  | { kind: 'interrupted' };

/**
 * Run one turn and classify the outcome. Owns the per-turn try/catch/finally so
 * the loop body stays flat: a clean interruption maps to `interrupted` (the
 * caller breaks), a thrown turn to `failed`, and a returned turn to `completed`
 * (carrying its application-level error flag). `session.finishTurn()` always
 * runs, matching the original `finally`.
 */
async function attemptTurn<TTurn>(
  strategy: AgentCliSessionStrategy<TTurn>,
  session: AgentCliSession,
  logger: AgentTrace,
  prompt: string,
  abortController: AbortController,
  startedAt: number,
): Promise<TurnAttempt<TTurn>> {
  try {
    const turn = await strategy.runTurn(prompt, abortController);
    logTurnSummary(logger, Date.now() - startedAt, strategy.getUsage(turn));
    const turnIsError = strategy.isTurnError?.(turn) === true;
    if (turnIsError) {
      strategy.onTurnError?.(turn, logger);
    }
    return { kind: 'completed', turn, turnIsError };
  } catch (caught) {
    if (isCleanInterruption(caught, abortController.signal, session)) {
      return { kind: 'interrupted' };
    }
    logger.error(toErrorMessage(caught));
    return { kind: 'failed', err: caught };
  } finally {
    session.finishTurn();
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
    logger.warn(`Failed to persist report for ${executionId}`, {
      data: result.err,
    });
  }
}

/**
 * Drive an agent-CLI session loop. The initial prompt is seeded into the child's
 * follow-up queue so the first turn goes through the same code path as every
 * follow-up turn. Each turn's result (or error) is delivered to the parent's
 * follow-up queue, persisted as a report, and the child stream is finalized when
 * the session is interrupted or a turn fails.
 */
export function runAgentCliSession<TTurn>(
  params: RunAgentCliSessionParams<TTurn>,
): void {
  const { childStream, parentStreamId, executionId, initialPrompt, strategy } =
    params;
  const { childStreamId, logger } = childStream;

  // Capture the run's session inside the tool's ALS so the cleanup below
  // unregisters against the same handle the registration used.
  const runSession = currentSession();
  const session = new AgentCliSession();
  const queue = runSession.followUps.acquire(childStreamId);
  session.setQueue(queue);
  runSession.interrupts.register(childStreamId, session);

  // The child session runs on its own trace, whose per-instance stage scope is
  // empty here, so this opens as a root with no cross-trace parent.
  const sessionStage = logger.openStage(strategy.stageLabel);

  strategy.onSessionStart?.(runSession);

  // Seed the initial prompt; the loop drains it as the first turn.
  queue.enqueue({ text: initialPrompt });
  childStream.waitForInput();

  let sawTurnFailure = false;
  void (async () => {
    try {
      while (!session.isInterrupted()) {
        const messages = await queue.waitAndDrainAll(() =>
          session.isInterrupted(),
        );
        if (!messages || session.isInterrupted()) break;

        const prompt = messages.items.map((item) => item.text).join('\n\n');
        childStream.beginTurn();
        const startedAt = Date.now();
        const abortController = session.startTurn();

        const attempt = await attemptTurn(
          strategy,
          session,
          logger,
          prompt,
          abortController,
          startedAt,
        );
        if (attempt.kind === 'interrupted') break;

        const turn = attempt.kind === 'completed' ? attempt.turn : null;
        const err = attempt.kind === 'failed' ? attempt.err : null;
        const turnIsError =
          attempt.kind === 'completed' ? attempt.turnIsError : false;

        const wallTimeMs = Date.now() - startedAt;
        const turnFailed = err != null || turnIsError;

        if (!turnFailed && turn != null) {
          strategy.onTurnSuccess?.(turn, runSession);
        }

        // publishUsage owns its own usage-presence check; the loop only needs a
        // turn to publish.
        if (turn != null) {
          strategy.publishUsage(turn);
        }

        const msg =
          turn != null && !turnFailed
            ? strategy.formatDelivery(turn, prompt, wallTimeMs)
            : strategy.formatError(turn, prompt, err);
        await persistReportBestEffort(executionId, msg, logger);
        const delivery = await deliverChildRunFollowUp({
          targetStreamId: parentStreamId,
          followUp: { text: msg, origin: 'subagent_result' },
          session: runSession,
          wake: true,
        });
        if (delivery.kind === 'no_session') {
          logger.warn(
            'Turn result not delivered: parent stream has no active session. The result remains in the execution report.',
            {
              data: {
                executionId,
                parentStreamId,
                streamStatus: delivery.streamStatus ?? 'unknown',
              },
            },
          );
        } else if (delivery.kind === 'dropped') {
          logger.warn(
            'Turn result dropped: parent stream is gone and could not be resumed. The result remains in the execution report.',
            { data: { executionId, parentStreamId } },
          );
        }

        if (turnFailed) {
          sawTurnFailure = true;
          childStream.failTurn();
          break;
        }

        if (!session.isInterrupted()) {
          childStream.waitForInput();
        }
      }
    } finally {
      runSession.interrupts.unregister(childStreamId);
      runSession.followUps.release(childStreamId);
      strategy.onSessionCleanup?.();
      // The shared terminal finalizer (via finalizeChildStream) owns the
      // single outcome derivation and its projections: stage end, persisted
      // terminal status (before untrack notifies waiters), settled result,
      // and terminal stream phase. This loop only reports its terminal facts.
      // Awaited so a headless CLI process cannot exit before the terminal
      // status persists to execution history.
      await childStream.finalize({
        failed: sawTurnFailure,
        cancelled: session.isInterrupted(),
        stage: sessionStage,
        persistTerminalStatus: true,
      });
    }
  })();
}
