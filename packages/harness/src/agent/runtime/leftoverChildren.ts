/**
 * What a dead process or a clean close left of a run's children, finished
 * as the parent resumes (`resumeLeftoverChildren`) or, for a process run a
 * detach left with no parent, as the session opens (`sweepLeftoverRuns`).
 * A child cut short (no end, or a clean close's cancelled end) whose rows
 * can continue is resumed under its own id, so its end reaches its parent
 * as it would have; one that cannot continue (a background command, a
 * resume refused once it decides) is reported to the parent once, as an
 * unknown outcome. Left alone: a run live here, one an open call of its
 * parent owns (the call resumes it), and one that ended on its own or
 * under a person's stop.
 */
import { Effect } from 'effect';

import { Inbox } from '@agent/followUp/Inbox';
import { describeFollowUpFailure } from '@agent/followUp/ToolUseFollowUp';
import { checkpointRefusal } from '@agent/storage/resumability';
import { endRunRows } from '@agent/storage/runLifecycle';
import { owningCall } from '@agent/storage/runRecords';
import { withLogChannel } from '@logger/effectLog';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { RUN_OUTCOME, type RunId } from '@shared/schemas';
import type { RunRows } from '@shared/session/runRowsShape';
import type { RunView } from '@shared/session/sessionView';
import { SessionViewAccess, SessionLog } from '@shared/session/runHistory';

import { formatDelivery } from './deliveryEnvelope';
import { resumeRun } from './resumeRun';
import { AgentRun, type RunLaunch } from './run/AgentRun';
import { Runs } from './runRegistry';

const CHANNEL = 'leftoverChildren';

const warn = (message: string, data: unknown) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ data }),
    withLogChannel(CHANNEL),
  );

/** The envelope a child's kind delivers its failure in. */
const TAG_OF = {
  process: DELIVERY_TAG.backgroundError,
  script: DELIVERY_TAG.scriptError,
  agent: DELIVERY_TAG.subagentError,
} as const;

/**
 * Tell `parent`, once per child lifecycle, that `child`'s work was
 * interrupted and its outcome is unknown (`why`: what refused its resume;
 * `finished`, it cannot continue by its kind). A child not ended ends
 * failed with the notice as its report, delivered by its end; one that
 * ended (a clean close stopped a task) only sends it.
 */
const reportInterrupted = Effect.fn('reportInterrupted')(function* (
  parent: RunId | null,
  child: RunView,
  facts: RunRows,
  why: string,
) {
  const noun =
    child.identity.kind === 'process' ? 'command' : child.identity.kind;
  const text = formatDelivery({
    tag: TAG_OF[child.identity.kind],
    runId: child.id,
    attributes:
      child.command === null ? [] : [{ name: 'command', value: child.command }],
    message: `The process running this ${noun} stopped before it finished${why === 'finished' ? '' : `, and it could not be resumed (${why})`}, so its outcome is unknown. Check what it changed before running it again.`,
  });
  if (facts.end === null) {
    yield* endRunRows({
      runId: child.id,
      outcome: RUN_OUTCOME.FAILED,
      error: { kind: 'unexpected', message: text },
      report: text,
    });
    return;
  }
  if (parent === null) return;
  const sent = yield* (yield* Inbox).send(parent, {
    text,
    from: { kind: 'run', runId: child.id },
    deliveryId: `${child.id}:${facts.activation?.commit ?? 0}:interrupted`,
  });
  if (sent.kind === 'refused')
    yield* warn(`Child run ${child.id}: its parent took no notice`, {
      parent,
      reason: sent.reason,
    });
});

/** Work the cut left open: no end, or the end a clean close's stop
 *  wrote, as opposed to a run that ended on its own or under a person's
 *  stop. */
export const cutShort = ({ end, stop }: RunRows): boolean =>
  end === null ||
  (end.outcome === RUN_OUTCOME.CANCELLED && stop?.reason === 'shutdown');

/** The one closer of what a dead process or a clean close left of `run`
 *  ({@link resumeLeftoverChildren}, `sweepLeftoverRuns`). A child resumed
 *  under its parent takes the keys the parent's activation carries, as a
 *  child it starts does; a sweep has no parent and brings none. */
export const closeLeftoverRun = Effect.fn('closeLeftoverRun')(function* (
  parent: Pick<RunLaunch, 'runId' | 'apiKeys'> | null,
  run: RunView,
) {
  if ((yield* Runs).get(run.id) !== undefined) return;
  const facts = yield* (yield* SessionLog).facts(run.id);
  if (facts === null || !cutShort(facts)) return;
  if ((yield* owningCall(run.id)) !== null) return;
  const parentRunId = parent?.runId ?? null;
  const report = (why: string) =>
    reportInterrupted(parentRunId, run, facts, why);
  const rejection = yield* checkpointRefusal(run.id);
  if (rejection !== null) return yield* report(rejection.kind);
  // A resume refused once it decides is reported; one blocked on a missing
  // agent or plugin, or one that failed, is left for the next resume, said
  // once. Forked: the caller goes on while the child's opening commits.
  const told = (what: string) => (error: unknown) =>
    warn(`Child run ${run.id} ${what}`, { parent: parentRunId, error });
  yield* Effect.forkScoped(
    Effect.matchEffect(resumeRun(run.id, { apiKeys: parent?.apiKeys }), {
      onSuccess: (answer) =>
        'failed' in answer && answer.failed.kind !== 'blocked'
          ? report(describeFollowUpFailure(answer.failed.kind))
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
    yield* (yield* SessionLog).settled;
    const { runs } = yield* (yield* SessionViewAccess).read([]);
    for (const child of runs.values())
      if (child.parentId === parent.runId)
        yield* closeLeftoverRun(parent, child);
  },
);
