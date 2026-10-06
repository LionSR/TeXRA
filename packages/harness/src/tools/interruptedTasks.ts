/**
 * Open-time continuation (durable harness, gap 2; ruling Q2), for a session
 * a TUI, desktop or extension window opened. Headless runs and the SDK never
 * start it: their policy is `off`. `texra resume <id>` starts only its
 * retries: an open-time resume beside that one would race it.
 *
 * At open it finds the interrupted roots: runs no process holds that did not
 * end, launched by a user (an owned child is resumed by its parent's call,
 * HQ6). Each one a resume would find blocked gets its reason in the
 * projection (`RunView.resumeBlocked`). Under `texra.resumeOnOpen: auto` the
 * rest are resumed, and a blocked one is resumed once it is unblocked; under
 * `ask` they are left for the window to list.
 *
 * Then it follows the agent catalog, which reloads when an agent file or a
 * plugin's switch or trust changes: each run a resume found blocked is
 * checked again, its reason cleared once nothing blocks it, and the run
 * resumed when a resume was asked for (`retry`).
 */
import { Deferred, Effect, Queue, type Scope } from 'effect';

import { resumeOnSession } from '@agent/followUp/ToolUseFollowUp';
import { resumeBlocker } from '@agent/runtime/resumeBlocker';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getRunRecords } from '@agent/storage/runRecords';
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import type { AgentCatalogServices } from '@platform/processRuntime';
import {
  RESUME_ON_OPEN_SETTING,
  RUN_SUBSTATE,
  type ResumeOnOpen,
  type RunId,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { claimStanding } from '@shared/session/database';
import { readSettingFrom } from '@utils/config/platformSettings';

const CHANNEL = 'InterruptedTasks';

/** Check a run again: mark what blocks it, or resume it when `resume`. */
const checkRun = (session: SessionHandle, runId: RunId, resume: boolean) =>
  Effect.gen(function* () {
    const config = yield* getRunRecords(session, runId).readConfig();
    if (config === null) return yield* session.markResumeBlocked(runId, null);
    const blocker = yield* resumeBlocker(session, config);
    if (blocker !== null)
      return yield* session.markResumeBlocked(runId, {
        reason: blocker,
        retry: resume,
      });
    // Nothing blocks it now. A resume that finds it blocked again records
    // that itself; one refused for any other reason leaves no stale block.
    yield* session.markResumeBlocked(runId, null);
    if (resume) yield* resumeOnSession(runId, session);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Task ${runId} could not be checked for what it needs to continue`,
      ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
    ),
  );

export const followInterruptedTasks = Effect.fn('followInterruptedTasks')(
  function* (
    session: SessionHandle,
    /** Find the interrupted tasks at open too, not only retry blocked
     *  resumes. */
    offer: boolean,
  ) {
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
      resume: boolean,
    ): Effect.Effect<void, never, Scope.Scope | AgentCatalogServices> =>
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
            checkRun(session, runId, resume).pipe(
              Effect.ensuring(
                Effect.suspend(() => {
                  checking.delete(runId);
                  const blocked = session
                    .resumeBlocks()
                    .find((b) => b.runId === runId);
                  return entry.again && blocked !== undefined
                    ? check(runId, blocked.retry)
                    : Effect.void;
                }),
              ),
            ),
          ),
        );
      });
    if (offer) {
      const policy = yield* readSettingFrom<ResumeOnOpen>(
        session.roots,
        RESUME_ON_OPEN_SETTING.configKey,
      );
      const view = yield* session.readView([]);
      const roots = [...view.runs.values()].filter(
        (run) =>
          run.parentId === null &&
          run.identity.kind === 'agent' &&
          run.substate !== RUN_SUBSTATE.PAUSED &&
          !isTerminalOutcomePhase(run.status) &&
          !session.runs.isLive(run.id),
      );
      // Interrupted: no live process holds it (the claim's owner is proved
      // dead, or there is none).
      const interrupted = yield* Effect.filter(roots, (run) =>
        Effect.map(
          session.claimOwner(run.id),
          (claim) => claimStanding(claim).kind === 'free',
        ),
      );
      for (const run of interrupted) yield* check(run.id, policy === 'auto');
    }
    yield* Effect.forever(
      Effect.andThen(Queue.take(changed), () =>
        Effect.forEach(
          session.resumeBlocks(),
          ({ runId, retry }) => check(runId, retry),
          { discard: true },
        ),
      ),
    );
  },
);
