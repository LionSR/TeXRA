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

import { REFUSED } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { checkpointRefusal } from '@agent/storage/resumability';
import {
  getRunRecords,
  owningCall,
  persistedParentId,
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

import {
  executeAgent,
  type ExecuteAgentOptions,
  type PreparedRun,
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
 *  registry's launch ends with no fiber behind it, and answered as what it
 *  carries (the refusal, or the parent that owns the run). */
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
 * ({@link joinOpening}), one whose end is stored is resumed once that
 * fiber has left, and a stop asked while the decision reads ends the run
 * and opens nothing.
 */
export const resumeRun = (
  runId: RunId,
  options: ResumeRunOptions,
): Effect.Effect<ResumeHandOff, Error, RunRegistry> =>
  Effect.flatMap(RunRegistry, (runs) =>
    runs
      .start(runId, {
        open: openResume(runs, runId, options),
        run: (opened) => opened.run,
      })
      .pipe(
        Effect.map(({ opened }): ResumeHandOff => ({
          activation: opened.activation,
        })),
        Effect.catchTag('ResumeNotOpened', (notOpened) =>
          Effect.succeed<ResumeHandOff>(notOpened.answer),
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
 * A resume of a run a launch here holds: one still opening (a wake's resume
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
    // Once the opening has finished, whichever way: one that failed left no
    // run here, which reads below as not resumable, and its launch reports
    // the failure.
    (runs.openingOf(runId) ?? Effect.void).pipe(
      Effect.andThen(
        runs.inSession(
          Effect.gen(function* () {
            const held = runs.get(runId);
            if (held === undefined) return REFUSED;
            const owner = yield* owningCall(runId);
            if (owner !== null) return { ownedBy: owner.parentId };
            const facts = yield* (yield* SessionLog).facts(runId);
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

/** The resume's opening: its decision, then the run's activation. A child
 *  an open call of `owner` owns resumes for that call alone: any other
 *  caller is sent to the owner. */
export const openResume = Effect.fn('resumeRun.open')(function* (
  runs: RunRegistry['Service'],
  runId: RunId,
  options: ResumeRunOptions,
  owner?: RunId,
): Effect.fn.Return<PreparedRun, Error | ResumeNotOpened, AgentRunServices> {
  const refuse = (answer: ResumeRefusalAnswer) =>
    Effect.fail(new ResumeNotOpened({ answer }));
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
  if (owning !== null && owning.parentId !== owner)
    return yield* refuse({ ownedBy: owning.parentId });
  // Nothing to continue from, or rows this build cannot use.
  const rejected = yield* checkpointRefusal(runId);
  if (rejected !== null) return yield* refuse({ failed: rejected });
  // Its parent, read once: the run's edge for this activation.
  const parentId = yield* persistedParentId(runId);
  // A stop asked while those reads ran: the registry ends the run on its
  // rows as this opening fails; there is nothing to activate.
  if (runs.stopAsked(runId) !== null) return yield* refuse(REFUSED);
  const definition = yield* prepareAgentDefinition({ config }).pipe(
    // An agent or plugin this process cannot run now refuses the resume
    // with the reason; the run stays interrupted, never failed, and
    // nothing is launched.
    Effect.catchTag('AgentUnavailable', ({ blocked }) =>
      refuse({ failed: blocked }),
    ),
  );
  return yield* executeAgent(definition, runId, {
    stopAfterCycle: options.stopAfterCycle,
    tools: options.tools,
    onProgress: options.onProgress,
    parentId,
  });
});
