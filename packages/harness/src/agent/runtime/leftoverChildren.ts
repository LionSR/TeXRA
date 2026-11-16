/**
 * What a process that exited left of a run's children, finished as the
 * parent resumes (`resumeLeftoverChildren`). A child left with no end
 * whose rows can continue is resumed under its own id, so its end reaches
 * its parent as it would have; one that cannot continue (a background
 * command, a resume refused once it decides) is reported to the parent
 * once, as an unknown outcome. Left alone: a run live here, one an open
 * call of its parent owns (the call resumes it), and one that ended.
 */
import { Effect } from 'effect';

import { checkpointRefusal } from '@agent/storage/resumability';
import { endRunRows } from '@agent/storage/runLifecycle';
import { owningCall } from '@agent/storage/runOwnership';
import { logFailure } from '@logger/effectLog';
import { DELIVERY_FAMILY } from '@shared/deliveryTags';
import { describeRefusal, RUN_OUTCOME } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { SessionViewAccess, SessionLog } from '@shared/session/runHistory';

import { resumeRun } from './resumeRun';
import { AgentRun, type RunLaunch } from './run/AgentRun';
import { Runs } from './runRegistry';

const CHANNEL = 'leftoverChildren';

/** The family a child's kind delivers in. */
const FAMILY_OF = {
  process: DELIVERY_FAMILY.background,
  script: DELIVERY_FAMILY.script,
  agent: DELIVERY_FAMILY.subagent,
} as const;

/**
 * Tell its parent that `child`'s work was interrupted and its outcome is
 * unknown (`why`: what refused its resume; `finished`, it cannot continue
 * by its kind): the child ends failed with the notice as its report,
 * which its end delivers.
 */
const reportInterrupted = Effect.fn('reportInterrupted')(function* (
  child: RunView,
  why: string,
) {
  const noun =
    child.identity.kind === 'process' ? 'command' : child.identity.kind;
  const message = `The process running this ${noun} stopped before it finished${why === 'finished' ? '' : `, and it could not be resumed (${why})`}, so its outcome is unknown. Check what it changed before running it again.`;
  const delivery = {
    family: FAMILY_OF[child.identity.kind],
    runId: child.id,
    attributes:
      child.command === null ? [] : [{ name: 'command', value: child.command }],
    message,
  };
  yield* endRunRows({
    runId: child.id,
    outcome: RUN_OUTCOME.FAILED,
    error: { kind: 'unexpected', message },
    report: delivery,
  });
});

/** The one closer of what a process that exited left of `run`, a child of
 *  the resuming `parent`. A child resumed under its parent
 *  opens in the parent's run fiber and takes its `LaunchKeys`, as a child
 *  it starts does. */
const closeLeftoverRun = Effect.fn('closeLeftoverRun')(function* (
  parent: Pick<RunLaunch, 'runId'>,
  run: RunView,
) {
  if ((yield* Runs).get(run.id) !== undefined) return;
  const facts = yield* (yield* SessionLog).facts(run.id);
  if (facts === null || facts.end !== null) return;
  if ((yield* owningCall(run.id)) !== null) return;
  const parentRunId = parent.runId;
  const report = (why: string) => reportInterrupted(run, why);
  const rejection = yield* checkpointRefusal(run.id);
  if (rejection !== null) return yield* report(rejection.kind);
  // A resume refused once it decides is reported; one blocked on a missing
  // agent or plugin, or one that failed, is left for the next resume, said
  // once. Forked: the caller goes on while the child's opening commits.
  const told = (what: string) => (error: unknown) =>
    logFailure(
      CHANNEL,
      `Child run ${run.id} ${what}`,
    )({ parent: parentRunId, error });
  yield* Effect.forkScoped(
    Effect.matchEffect(resumeRun(run.id, {}), {
      onSuccess: (answer) =>
        'failed' in answer && answer.failed.kind !== 'blocked'
          ? report(describeRefusal(answer.failed))
          : Effect.void,
      onFailure: told('was not resumed'),
    }).pipe(Effect.catch(told('was not reported interrupted'))),
  );
});

/** {@link closeLeftoverRun} of the resuming run's children (`AgentRun`). */
export const resumeLeftoverChildren = Effect.fn('resumeLeftoverChildren')(
  function* () {
    const parent = yield* AgentRun;
    // The listing with this run's activation applied: a child is started
    // under a run the view reads as running, not as stopped.
    yield* (yield* SessionLog).drained;
    const { runs } = yield* (yield* SessionViewAccess).read([]);
    for (const child of runs.values())
      if (child.parentId === parent.runId)
        yield* closeLeftoverRun(parent, child);
  },
);
