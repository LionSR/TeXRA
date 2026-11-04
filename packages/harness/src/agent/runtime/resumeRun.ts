import { Clock, Deferred, Effect, Result, type Scope } from 'effect';

/**
 * The one resume path. A host continues a persisted run through
 * {@link resumeRun}, a wake through `wakeRun`; both open the run's
 * activation here or join the one in flight (`RunRegistry.resume`), and
 * hear its one answer: the commit of the `run.activate` it opened, or why
 * it opened none. The decision ({@link decideResume}) is the activation's
 * program: a stop reaches it from the call, and the generation it launches
 * runs on its fiber, under the claim the activation holds. A caller only
 * observes: leaving early changes nothing about the run.
 */
import { Inbox, openResume } from '@agent/followUp/ToolUseFollowUp';
import { earlierBuildRefusal, runRejection } from '@agent/storage/resumability';
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runRecords';
import type { RunId } from '@shared/schemas';
import { SessionViewAccess } from '@shared/session/runHistory';
import { createNativeSubagentStrategy } from './nativeSubagentStrategy';
import { createScriptRunStrategy } from './scriptRun';
import { resumeBlocker } from './resumeBlocker';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { deliverHeld } from './runLaunchGuard';
import { resumeChildRunLoop } from './childRunLoop';
import type { AgentRunServices } from './runRegistry';
import type { LaunchAnswer } from './runs';
import type { SessionServices } from './rootLaunch';

/** What a resume's caller supplies: the run's extra tools, and whether it
 *  stops after one cycle. It resumes in the caller's session. */
export interface ResumeRunOptions extends Pick<ExecuteAgentOptions, 'tools'> {
  /** Stop the run after one model/tool cycle instead of waiting for
   *  follow-up input. */
  readonly stopAfterCycle?: boolean;
}

/** A resume's refusal of a run that cannot continue here. */
const NOT_RESUMABLE: LaunchAnswer = { failed: { kind: 'notResumable' } };

/**
 * Resume `runId`, or join the launch of it in flight here, and answer once
 * the run's activation commits (`activation`), or with why it opened none:
 * refused (`failed`), or owned by an open call of `ownedBy`, for a caller
 * that follows the parent itself. A run live here answers with the
 * activation it has.
 */
export const resumeRun = (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.Effect<LaunchAnswer, Error, SessionServices> =>
  Effect.flatten(openResume(runId, options));

/**
 * One resume's decision, the program of the activation it runs on
 * (`RunRegistry.resume`): it completes `answer` with a refusal or an owning
 * parent, or runs the generation on this fiber, whose `run.activate` row
 * answers. The activation holds the run's claim for the generation's life
 * (`RunRegistry.admit`); a live owner elsewhere refused it before this
 * ran, which the door reads as `ownedElsewhere`.
 */
export const decideResume = Effect.fn('decideResume')(function* (
  runId: RunId,
  options: ResumeRunOptions,
  answer: Deferred.Deferred<LaunchAnswer, Error>,
): Effect.fn.Return<void, Error, AgentRunServices | Scope.Scope> {
  const inbox = yield* Inbox;
  const refuse = (answered: LaunchAnswer) =>
    Effect.asVoid(Deferred.succeed(answer, answered));
  const store = getRunRecords(runId);
  const records = yield* Effect.result(
    Effect.all([store.readConfig(), store.exists()]),
  );
  // A record read refuses a run holding an earlier build's row, wherever
  // the row sits: this build cannot open the run.
  if (Result.isFailure(records)) {
    const earlier = earlierBuildRefusal(records.failure);
    if (earlier === undefined) return yield* Effect.fail(records.failure);
    return yield* refuse({ failed: earlier });
  }
  const [config, exists] = records.success;
  if (!config || !exists) {
    // A run whose records are gone: with nothing queued its input ends.
    yield* inbox.closeInput(runId);
    return yield* refuse(NOT_RESUMABLE);
  }
  // Deleted, or its input closed, while those reads ran.
  if ((yield* inbox.read(runId)).inputClosed)
    return yield* refuse(NOT_RESUMABLE);
  // Whether an open call owns it, read under the activation's claim, so
  // the answer and the launch below are one decision.
  const owner = yield* owningCall(runId);
  if (owner !== null) return yield* refuse({ ownedBy: owner.parentRunId });
  // What its children hold for it, it reads once it runs here.
  yield* deliverHeld(runId);
  // Nothing to continue from, or rows this build cannot open.
  const rejected = yield* runRejection(runId);
  if (rejected !== null) return yield* refuse({ failed: rejected });
  // An agent or plugin this process cannot run now leaves the run
  // interrupted with the reason, never failed, for the session's follower to
  // resume once it is back; nothing is launched. Another process's run
  // is refused as such above, whatever this process lacks.
  const blocker = yield* resumeBlocker(config);
  yield* (yield* SessionViewAccess).markResumeBlocked(runId, blocker);
  if (blocker !== null) return yield* refuse({ failed: blocker });
  // The generation, on this fiber. Its parent, read once under the claim,
  // is the run's edge for this activation.
  const parentRunId = yield* persistedParentRunId(runId);
  if (parentRunId === undefined) {
    const definition = yield* prepareAgentDefinition({
      config,
      stopAfterCycle: options.stopAfterCycle,
    });
    yield* executeAgent(definition, runId, { tools: options.tools });
    return;
  }
  const native = {
    runId,
    startedAt: yield* Clock.currentTimeMillis,
    workingDirectory: config.workingDirectory ?? undefined,
    resume: { ...options, config, parent: Effect.succeed(parentRunId) },
  };
  const { script } = config;
  yield* resumeChildRunLoop({
    runId,
    parentRunId,
    agentName: config.agent,
    strategy:
      script?.kind === 'background'
        ? createScriptRunStrategy({ ...native, title: script.title })
        : createNativeSubagentStrategy(native),
  });
}, Effect.scoped);
