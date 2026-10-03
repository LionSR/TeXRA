/**
 * Open-time continuation (durable harness, gap 2; ruling Q2), for a session
 * a TUI, desktop or extension window opened. Headless runs and the SDK never
 * start it: their policy is `off`.
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
import { Deferred, Effect, Queue } from 'effect';

import { resumeOnSession } from '@agent/followUp/ToolUseFollowUp';
import { resumeBlocker } from '@agent/runtime/resumeBlocker';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { getRunRecords } from '@agent/storage/runRecords';
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
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
    // The resume checks again, and clears the reason itself.
    if (resume) yield* resumeOnSession(runId, session);
    else yield* session.markResumeBlocked(runId, null);
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Task ${runId} could not be checked for what it needs to continue`,
      ).pipe(Effect.annotateLogs({ data: error }), withLogChannel(CHANNEL)),
    ),
  );

export const followInterruptedTasks = Effect.fn('followInterruptedTasks')(
  function* (session: SessionHandle) {
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

    const policy = yield* readSettingFrom<ResumeOnOpen>(
      session.roots,
      RESUME_ON_OPEN_SETTING.configKey,
    );
    const view = yield* session.readView([]);
    const roots = [...view.runs.values()].filter(
      (run) =>
        run.parentId === null &&
        run.identity.kind === 'agent' &&
        run.blocked === null &&
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
    // One check of a run at a time: a resume runs until the run is idle,
    // and a change meanwhile must not resume it twice.
    const checking = new Set<RunId>();
    const check = (runId: RunId, resume: boolean) =>
      Effect.suspend(() => {
        if (checking.has(runId)) return Effect.void;
        checking.add(runId);
        return Effect.asVoid(
          Effect.forkScoped(
            checkRun(session, runId, resume).pipe(
              Effect.ensuring(Effect.sync(() => checking.delete(runId))),
            ),
          ),
        );
      });
    for (const run of interrupted) yield* check(run.id, policy === 'auto');
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
