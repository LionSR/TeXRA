/**
 * The one resume path: a start from rows. A host continues a persisted run
 * through {@link resumeRun}, a wake (`wakeRun`) does the same with no
 * caller. The run is forked under its id (`RunRegistry.start`), and its
 * fiber decides the refusal from the run's records and opens it, which
 * answers the commit of its activation. A run a fiber here already drives
 * is answered as it runs. A child a dead process left resumes here too
 * (`resumeLeftoverChildren`), so its end reaches its parent as it would
 * have.
 */
import { Effect, Result, Schema } from 'effect';

import { REFUSED } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { continuationOf } from '@agent/storage/continuation';
import {
  agentConfigOf,
  getRunRecords,
  owningCall,
} from '@agent/storage/runOwnership';
import { logFailure } from '@logger/effectLog';
import {
  type CommitOrdinal,
  type ResumeRefusal,
  ResumeRefusalSchema,
  type RunId,
  RunIdSchema,
} from '@shared/schemas';
import { runReadRefusal, SessionLog } from '@shared/session/runHistory';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  type AgentLaunch,
  executeAgent,
  type ExecuteAgentOptions,
} from './executeAgent';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { type AgentRunServices, RunLive, RunRegistry } from './runRegistry';

/** What a resume answers: the commit of the activation it opened, which
 *  the caller now holds; the refusal its records decided; or the owning
 *  parent whose open call owns the run, which resumes with that parent. */
type ResumeHandOff =
  | { readonly activation: CommitOrdinal }
  | { readonly failed: ResumeRefusal }
  | { readonly ownedBy: RunId };

/** What a resume's caller supplies: the run's extra tools, its progress
 *  callback, and whether a root stops after one cycle. It resumes in the
 *  caller's session, with the caller's `LaunchKeys`. */
export type ResumeRunOptions = Pick<
  ExecuteAgentOptions,
  'tools' | 'onProgress' | 'stopAfterCycle'
>;

const CHANNEL = 'ResumeRun';

/** A resume's answer short of an activation: a refusal its records
 *  decided, or the owning parent. */
type ResumeRefusalAnswer = Exclude<
  ResumeHandOff,
  { activation: CommitOrdinal }
>;

/** A resume that did not open: told as the opening's failure, so the
 *  run's fiber ends with nothing opened, and answered as what it carries
 *  (the refusal, or the parent that owns the run). */
class ResumeNotOpened extends Schema.TaggedError<ResumeNotOpened>()(
  'ResumeNotOpened',
  {
    answer: Schema.Union([
      Schema.Struct({ failed: ResumeRefusalSchema }),
      Schema.Struct({ ownedBy: RunIdSchema }),
    ]),
  },
) {}

/**
 * The one reading of a resume's failure, at each step that can fail (its
 * record read, its launch): stored rows this build cannot use refuse the
 * resume; any other failure, the disk's, fails it. A launch already here
 * is {@link joinOpening}'s, and one a stop cut is refused.
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
  return logFailure(
    CHANNEL,
    `Refusing to resume ${runId}: its saved state cannot be used (${refused}): ${cause}`,
  )(error).pipe(Effect.as({ failed: { kind: 'unusableCheckpoint' } } as const));
}

/**
 * Resume `runId`: on the run's own fiber, decide its refusal from its
 * records (gone, closed, owned by an open call of its parent, nothing to
 * continue from, an agent or plugin this process cannot run), then open
 * it, a conversation under its stored configuration and a child under its
 * parent's edge. Answers once the activation committed. The whole of it is
 * the registry's launch (`RunRegistry.start`), on the session's context
 * whichever fiber asks (a host's, a wake's, a tool's): a run a fiber here
 * drives or opens is answered as it runs ({@link joinOpening}), one whose
 * end is stored is resumed once that fiber has left, and a stop that cuts
 * the decision or the opening refuses the resume.
 */
export const resumeRun = (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.Effect<ResumeHandOff, Error, RunRegistry> =>
  Effect.flatMap(RunRegistry, (runs) =>
    runs.start(runId, executeAgent(runId, openResume(runId, options))).pipe(
      Effect.map(({ opened }): ResumeHandOff => ({
        activation: opened.activation,
      })),
      Effect.catchTag('ResumeNotOpened', (notOpened) =>
        Effect.succeed<ResumeHandOff>(notOpened.answer),
      ),
      Effect.catchTag('RunStopped', () =>
        Effect.succeed<ResumeHandOff>(REFUSED),
      ),
      Effect.catch((error) =>
        error instanceof RunLive
          ? Effect.flatMap(joinOpening(runs, runId), (joined) =>
              joined === null
                ? resumeRun(runId, options)
                : Effect.succeed(joined),
            )
          : refusalFor(error, runId),
      ),
    ),
  );

/**
 * A resume of a run a fiber here drives: one still opening (a wake's resume
 * of the same input, a host's second resume) is joined, then the run is
 * answered as it runs here: the activation it runs, or, for a child an open
 * call of its parent owns, that parent, whose conversation it belongs to.
 * One whose opening failed is not resumable. One whose activation's end is
 * already stored, its fiber still leaving, runs here no more: once that
 * fiber has left this answers `null`, and the resume starts over.
 */
const joinOpening = (
  runs: RunRegistry['Service'],
  runId: RunId,
): Effect.Effect<ResumeHandOff | null> =>
  Effect.suspend(() =>
    // Once the opening has answered, whichever way: one that failed left no
    // run here, which reads below as not resumable, and its launch reports
    // the failure.
    (runs.opened(runId) ?? Effect.void).pipe(
      Effect.andThen(
        runs.inSession(
          Effect.gen(function* () {
            const held = runs.get(runId);
            if (held === undefined) return REFUSED;
            const facts = yield* (yield* SessionLog).facts(runId);
            const owner = yield* owningCall(runId, facts);
            if (owner !== null) return { ownedBy: owner.parentId };
            if (facts?.activation == null) return REFUSED;
            if (facts.end === null)
              return { activation: facts.activation.commit };
            yield* held.drained;
            return null;
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

/** The resume's decision, on the run's fiber before it opens: the run's
 *  definition and options, or the refusal it fails with. A child an open
 *  call of `owner` owns resumes for that call alone: any other caller is
 *  sent to the owner. */
export const openResume = Effect.fn('resumeRun.open')(function* (
  runId: RunId,
  options: ResumeRunOptions,
  owner?: RunId,
): Effect.fn.Return<AgentLaunch, Error | ResumeNotOpened, AgentRunServices> {
  const refuse = (answer: ResumeRefusalAnswer) =>
    Effect.fail(new ResumeNotOpened({ answer }));
  const inbox = yield* Inbox;
  // The run's facts, read once: every decision below, and the opening's
  // (`ExecuteAgentOptions.resumed`), is made from them.
  // The read fails on a row this build cannot use, wherever it sits.
  const read = yield* Effect.result((yield* SessionLog).facts(runId));
  if (Result.isFailure(read))
    return yield* Effect.flatMap(refusalFor(read.failure, runId), refuse);
  const facts = read.success;
  const config = agentConfigOf(facts);
  if (config === null) {
    // A run whose records are gone: with nothing queued its input ends.
    yield* inbox.closeInput(runId);
    return yield* refuse(REFUSED);
  }
  // Deleted, or its input closed, while that read ran.
  if ((yield* inbox.read(runId)).inputClosed) return yield* refuse(REFUSED);
  // Whether an open call owns it: that call's parent resumes instead.
  const owning = yield* owningCall(runId, facts);
  if (owning !== null && owning.parentId !== owner)
    return yield* refuse({ ownedBy: owning.parentId });
  // Nothing to continue from.
  const continuation = continuationOf(facts);
  if (continuation.kind !== 'checkpoint')
    return yield* refuse({ failed: continuation });
  // Its parent, less one the store no longer lists: the run's edge for
  // this activation, taken from its rows, never from its caller.
  const edge = facts?.start?.parent?.id;
  const parentId =
    edge !== undefined && (yield* getRunRecords(edge).exists())
      ? edge
      : undefined;
  const definition = yield* prepareAgentDefinition({ config }).pipe(
    // An agent or plugin this process cannot run now refuses the resume
    // with the reason; the run stays interrupted, never failed, and
    // nothing is launched.
    Effect.catchTag('AgentUnavailable', ({ blocked }) =>
      refuse({ failed: blocked }),
    ),
  );
  return {
    definition,
    options: {
      stopAfterCycle: options.stopAfterCycle,
      tools: options.tools,
      onProgress: options.onProgress,
      resumed: { parentId, start: facts?.start ?? null },
    },
  };
});
