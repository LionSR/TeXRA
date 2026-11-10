/**
 * The one resume path: a start from rows. A host continues a persisted run
 * through {@link resumeRun}, a wake (`wakeRun`) does the same with no
 * caller. The refusal is decided from the run's records; then the run is
 * opened in the caller's fiber and forked under its id (`RunRegistry.start`),
 * which answers the commit of its activation. A run a fiber here already
 * drives is answered as it runs. A child a dead process left resumes
 * here too (`resumeLeftoverChildren`), so its end reaches its parent as it
 * would have.
 */
import { Effect, Result, Schema } from 'effect';

import {
  describeFollowUpFailure,
  REFUSED,
} from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { checkpointRefusal } from '@agent/storage/resumability';
import {
  getRunRecords,
  owningCall,
  persistedParentRunId,
} from '@agent/storage/runOwnership';
import { withLogChannel } from '@logger/effectLog';
import {
  type CommitOrdinal,
  type ResumeRefusal,
  ResumeRefusalSchema,
  type RunId,
  RunIdSchema,
} from '@shared/schemas';
import { runReadRefusal, SessionLog } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { resumeBlocker } from './resumeBlocker';

import {
  executeAgent,
  type ExecuteAgentOptions,
  type PreparedRun,
} from './executeAgent';
import { prepareAgentDefinition } from './AgentLaunchContext';
import {
  registryOf,
  type AgentRunServices,
  RunLive,
  type RunRegistry,
  Runs,
} from './runRegistry';

/** What a resume answers: the commit of the activation it opened, which
 *  the caller now holds; the refusal its records decided; or the owning
 *  parent whose open call owns the run, which resumes with that parent. */
export type ResumeHandOff =
  | { readonly activation: CommitOrdinal }
  | { readonly failed: ResumeRefusal }
  | { readonly ownedBy: RunId };

/** What a resume's caller supplies: the run's extra tools, its progress
 *  callback, and whether it stops after one cycle. It resumes in the
 *  caller's session, with the caller's `LaunchKeys`. */
export interface ResumeRunOptions extends Pick<
  ExecuteAgentOptions,
  'tools' | 'onProgress'
> {
  /** Stop the run after one model/tool cycle instead of waiting for
   *  follow-up input. */
  readonly stopAfterCycle?: boolean;
}

/** A resume refusal's wording: a blocked one names the agent or plugin it
 *  waits for; every other reads as its kind. */
export function describeResumeRefusal(reason: ResumeRefusal): string {
  if (reason.kind !== 'blocked') return describeFollowUpFailure(reason.kind);
  switch (reason.blocker) {
    case 'agentMissing':
      return `This task's agent, ${reason.name}, is not installed. It can continue once the agent is back.`;
    case 'pluginOff':
      return `This task's agent comes from the ${reason.name} plugin, which is off. It can continue once the plugin is on.`;
    case 'pluginUntrusted':
      return `This task's agent comes from the ${reason.name} plugin, which is not trusted as it is now. It can continue once the plugin is reviewed.`;
  }
}

const CHANNEL = 'ResumeRun';

/** A resume's answer short of an activation: a refusal its records
 *  decided, or the owning parent. */
type ResumeRefusalAnswer = Exclude<
  ResumeHandOff,
  { activation: CommitOrdinal }
>;

/** A resume refused as it opens: told as the opening's failure, so the
 *  registry's launch ends with no fiber behind it, and answered as the
 *  refusal it carries. */
class ResumeRefused extends Schema.TaggedError<ResumeRefused>()(
  'ResumeRefused',
  {
    answer: Schema.Union([
      Schema.Struct({ failed: ResumeRefusalSchema }),
      Schema.Struct({ ownedBy: RunIdSchema }),
    ]),
  },
) {}

/**
 * The one reading of a resume's failure, at each step that can fail (its
 * record read, its launch): one a stop met as it opened, or stored rows
 * this build cannot use, refuse the resume; any other failure, the disk's,
 * fails it. A launch already here is {@link joinOpening}'s.
 */
function refusalFor(
  error: Error,
  runId: RunId,
): Effect.Effect<ResumeRefusalAnswer, Error> {
  const refused = runReadRefusal(error);
  if (refused === undefined) return Effect.fail(error);
  const cause = toErrorMessage(error);
  if (refused === 'earlierBuild')
    return Effect.succeed({ failed: { kind: 'earlierBuild', cause } });
  return Effect.logWarning(
    `Refusing to resume ${runId}: its saved state cannot be used (${refused}): ${cause}`,
  ).pipe(
    Effect.annotateLogs({ data: error }),
    withLogChannel(CHANNEL),
    Effect.as({ failed: { kind: 'unusableCheckpoint' } } as const),
  );
}

/**
 * Resume `runId`: decide its refusal from its records (gone, closed, owned
 * by an open call of its parent, nothing to continue from, an agent or
 * plugin this process cannot run), then open it in this fiber and fork it
 * under its id, a conversation under its stored configuration and a child
 * under its parent's edge. Answers once the activation committed. The
 * whole of it is the registry's launch (`RunRegistry.start`), on the
 * session's context whichever fiber asks (a host's, a wake's, a tool's):
 * a run a fiber here drives or opens is answered as it runs
 * ({@link joinOpening}), and a stop asked while the decision reads ends
 * the run and opens nothing.
 */
export const resumeRun = (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.Effect<ResumeHandOff, Error, Runs> =>
  Effect.flatMap(Runs, (service) => {
    const runs = registryOf(service);
    return runs
      .start(runId, {
        open: openResume(runs, runId, options),
        run: (opened) => opened.run,
      })
      .pipe(
        Effect.map(({ opened }): ResumeHandOff => ({
          activation: opened.activation,
        })),
        Effect.catchTag('ResumeRefused', (refused) =>
          Effect.succeed<ResumeHandOff>(refused.answer),
        ),
        Effect.catch((error) =>
          error instanceof RunLive
            ? joinOpening(runs, runId)
            : refusalFor(error, runId),
        ),
      );
  });

/**
 * A resume of a run a launch here holds: one still opening (a wake's resume
 * of the same input, a host's second resume) is joined, then the run is
 * answered as it runs here: the activation it runs, or, for a child an open
 * call of its parent owns, that parent, whose conversation it belongs to.
 * One whose opening failed is not resumable.
 */
const joinOpening = (
  runs: RunRegistry,
  runId: RunId,
): Effect.Effect<ResumeHandOff> =>
  Effect.suspend(() =>
    (runs.openingOf(runId) ?? Effect.void).pipe(
      // An opening that failed leaves no run here, which reads below as
      // not resumable; its launch reports the failure.
      Effect.ignore,
      Effect.andThen(
        runs.inSession(
          Effect.gen(function* () {
            if (runs.get(runId) === undefined) return REFUSED;
            const owner = yield* owningCall(runId);
            if (owner !== null) return { ownedBy: owner.parentRunId };
            const facts = yield* (yield* SessionLog).facts(runId);
            return facts?.activation == null
              ? REFUSED
              : { activation: facts.activation.commit };
          }),
        ),
      ),
      // A run this resume cannot read is refused, and the read's failure
      // is logged rather than read as an ordinary refusal.
      Effect.catch((error) =>
        Effect.logWarning(
          `Could not read run ${runId} to join its opening; the resume is refused.`,
          error,
        ).pipe(Effect.as(REFUSED)),
      ),
    ),
  );

/** The resume's opening: its decision, then the run's activation. A child
 *  an open call of `owner` owns resumes for that call alone: any other
 *  caller is sent to the owner. */
export const openResume = Effect.fn('resumeRun.open')(function* (
  runs: RunRegistry,
  runId: RunId,
  options: ResumeRunOptions,
  owner?: RunId,
): Effect.fn.Return<PreparedRun, Error | ResumeRefused, AgentRunServices> {
  const refuse = (answer: ResumeRefusalAnswer) =>
    Effect.fail(new ResumeRefused({ answer }));
  const inbox = yield* Inbox;
  const store = getRunRecords(runId);
  const records = yield* Effect.result(
    Effect.all([store.readConfig(), store.exists()]),
  );
  // A record read fails on a row this build cannot use, wherever it sits.
  if (Result.isFailure(records))
    return yield* Effect.flatMap(refusalFor(records.failure, runId), refuse);
  const [config, exists] = records.success;
  if (!config || !exists) {
    // A run whose records are gone: with nothing queued its input ends.
    yield* inbox.closeInput(runId);
    return yield* refuse(REFUSED);
  }
  // Deleted, or its input closed, while those reads ran.
  if ((yield* inbox.read(runId)).inputClosed) return yield* refuse(REFUSED);
  // Whether an open call owns it: that call's parent resumes instead.
  const owning = yield* owningCall(runId);
  if (owning !== null && owning.parentRunId !== owner)
    return yield* refuse({ ownedBy: owning.parentRunId });
  // Nothing to continue from, or rows this build cannot use.
  const rejected = yield* checkpointRefusal(runId);
  if (rejected !== null) return yield* refuse({ failed: rejected });
  // An agent or plugin this process cannot run now refuses the resume with
  // the reason; the run stays interrupted, never failed, and nothing is
  // launched.
  const blocker = yield* resumeBlocker(config);
  if (blocker !== null) return yield* refuse({ failed: blocker });
  // Its parent, read once: the run's edge for this activation; and whether
  // its launch let it take input (`run.start.takesFollowUps`).
  const parentRunId = yield* persistedParentRunId(runId);
  const takesInput =
    (yield* (yield* SessionLog).facts(runId))?.start?.takesFollowUps !== false;
  // A stop asked while those reads ran: the registry ends the run on its
  // rows as this opening fails; there is nothing to activate.
  if (runs.stopAsked(runId) !== null) return yield* refuse(REFUSED);
  // A child runs one cycle and ends with its report, and so does a root
  // launched to run once, which no message may reach, whoever resumes it;
  // any other root as its caller asks.
  const definition = yield* prepareAgentDefinition({
    config,
    stopAfterCycle:
      options.stopAfterCycle || parentRunId !== undefined || !takesInput,
  });
  return yield* executeAgent(definition, runId, {
    tools: options.tools,
    onProgress: options.onProgress,
    parentRunId,
  });
});
