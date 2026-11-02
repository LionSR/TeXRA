/**
 * Open-time recovery: what a session does with the tasks a closed or
 * crashed process left interrupted, started by the open that asks for it
 * (`OpenOptions.host.interruptedTasks`, `list` or `resume`). A session
 * opened without it recovers nothing at open.
 *
 * At open it finds the interrupted roots: runs no process holds that did not
 * end, launched by a user (an owned child is resumed by its parent's call).
 * Each one a resume would find blocked gets its reason in the
 * projection (`RunView.resumeBlocked`). Under `resume` the rest are resumed,
 * and a blocked one is resumed once it is unblocked; under `list` they are
 * left for the host to list.
 *
 * Then it follows the agent catalog, which reloads when an agent file or a
 * plugin's switch or trust changes: each run a resume found blocked is
 * checked again, its reason cleared once nothing blocks it, and the run
 * resumed under `resume`. What an earlier open asked for is not kept, by
 * this process or any other.
 */
import { Deferred, Effect, Queue, type Scope } from 'effect';

import { wakeRun } from '@agent/followUp/ToolUseFollowUp';
import { getRunRecords } from '@agent/storage/runRecords';
import type { AgentCatalog } from '@agent/index/agentCatalog';
import type { AgentCatalogServices } from '@agent/index/agentEntry';
import { withLogChannel } from '@logger/effectLog';
import { onAppSignal } from '@platform/appSignals';
import { RESTING_SUBSTATES, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { claimStanding } from '@shared/session/database';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

import { resumeBlocker } from './resumeBlocker';
import { Runs } from './runRegistry';
import type { SessionServices } from './rootLaunch';

const CHANNEL = 'InterruptedTasks';

/** Check a run again: mark what blocks it, or resume it when `resume`. */
const checkRun = (runId: RunId, resume: boolean) =>
  Effect.gen(function* () {
    const view = yield* SessionViewAccess;
    const config = yield* getRunRecords(runId).readConfig();
    if (config === null) return yield* view.markResumeBlocked(runId, null);
    const blocker = yield* resumeBlocker(config);
    // Nothing blocks it now: a resume that finds it blocked again records
    // that itself; one refused for any other reason leaves no stale block.
    yield* view.markResumeBlocked(runId, blocker);
    if (blocker === null && resume) yield* Effect.flatten(wakeRun(runId));
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Task ${runId} could not be checked for what it needs to continue`,
      ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
    ),
  );

export const followInterruptedTasks = Effect.fn('followInterruptedTasks')(
  function* (
    /** What an unblocked task does: waits to be listed, or is resumed. */
    recovery: 'list' | 'resume',
  ) {
    const resume = recovery === 'resume';
    const sessionView = yield* SessionViewAccess;
    // Subscribed before the open-time pass, so a catalog change during it
    // is not missed.
    const changed = yield* Queue.sliding<void>(1);
    const subscribed = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      onAppSignal(
        'workspaceAgentsChanged',
        () => Queue.offerUnsafe(changed, undefined),
        subscribed,
      ),
    );
    yield* Deferred.await(subscribed);

    // One check of a run at a time: a resume runs until the run is idle,
    // and a change meanwhile must not resume it twice. A change that lands
    // during a check checks the run again after it, with what it then
    // records, so no change is lost to a check that read the catalog before.
    const checking = new Map<RunId, { again: boolean }>();
    const check = (
      runId: RunId,
    ): Effect.Effect<
      void,
      never,
      Scope.Scope | AgentCatalog | AgentCatalogServices | SessionServices
    > =>
      Effect.suspend(() => {
        const running = checking.get(runId);
        if (running !== undefined) {
          running.again = true;
          return Effect.void;
        }
        const entry = { again: false };
        checking.set(runId, entry);
        return Effect.asVoid(
          Effect.forkScoped(
            checkRun(runId, resume).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  checking.delete(runId);
                  const blocked = sessionView
                    .resumeBlocks()
                    .some((b) => b.runId === runId);
                  return entry.again && blocked ? check(runId) : Effect.void;
                }),
              ),
            ),
          ),
        );
      });
    const view = yield* sessionView.read([]);
    const runs = yield* Runs;
    const log = yield* SessionLog;
    const roots = [...view.runs.values()].filter(
      (run) =>
        run.parentId === null &&
        run.identity.kind === 'agent' &&
        !RESTING_SUBSTATES.has(run.substate) &&
        !isTerminalOutcomePhase(run.status) &&
        runs.get(run.id) === undefined,
    );
    // Interrupted: no live process holds it (the claim's owner is proved
    // dead, or there is none).
    const interrupted = yield* Effect.filter(roots, (run) =>
      Effect.map(
        log.owner(run.id),
        (claim) => claimStanding(claim).kind === 'free',
      ),
    );
    for (const run of interrupted) yield* check(run.id);
    return yield* Effect.forever(
      Effect.andThen(Queue.take(changed), () =>
        Effect.forEach(
          sessionView.resumeBlocks(),
          ({ runId }) => check(runId),
          { discard: true },
        ),
      ),
    );
  },
);
