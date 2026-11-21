import { Cause, Context, Effect, Exit } from 'effect';
/** Tool-use follow-up routing and continuation ownership. */

import { checkpointRefusal } from '@agent/storage/continuation';
import { resumeRun } from '@agent/runtime/resumeRun';
import { LaunchKeys, RunRegistry } from '@agent/runtime/runRegistry';
import { logFailure, withLogChannel } from '@logger/effectLog';
import {
  describeRefusal,
  type ResumeRefusal,
  type RunId,
} from '@shared/schemas';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { withPerKeyLane } from '@utils/core/perKeyQueue';
import { sleepUntil, type SendVerdict } from './FollowUpReader';
import { wakeNotes } from './followUpMessages';
import { Inbox, type InboxItem } from './Inbox';

/** What a follow-up's acceptance and its wake read of the session. */
type FollowUpServices = Inbox | RunRegistry | SessionLog | SessionViewAccess;

/**
 * Three outcomes: the input reached a running loop, it waits in the run's
 * queue for its next turn (the resume the send started, or an explicit
 * one), or it was not accepted, with the words that say why. A delivery the
 * acceptance boundary had already accepted is `sent`. A resume the input
 * started that the run refused is told by the resume itself.
 */
export type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; message: string };

interface SubmitFollowUpOptions {
  /** A user's message the run reads when its current turn ends, not at the
   *  turn's next model request. */
  readonly hold?: 'turn';
  /** What the message's read files add to it, read in the run's send lane
   *  once the message is accepted, so a slow read never lets a later message
   *  commit first: its media, and the text its activated skills lead. */
  readonly prepare?: Effect.Effect<
    Partial<
      Pick<
        Extract<InboxItem, { readonly text: string }>,
        'text' | 'displayText' | 'media' | 'blobs'
      >
    >,
    Error
  >;
  /** The keys the run resumes with if the message wakes it: the sending
   *  client's (`followUp.send`'s `apiKeys`), never another run's. */
  readonly apiKeys?: Readonly<Record<string, string>>;
  /** The skills a user activated with the message (`followUp.send`'s
   *  `skills`), whose blocks its text already carries. */
  readonly skills?: readonly string[];
}

const CHANNEL = 'ToolUseFollowUp';

/** A resume's refusal of a run that cannot continue here. */
export const REFUSED: { readonly failed: ResumeRefusal } = Object.freeze({
  failed: Object.freeze({ kind: 'notResumable' }),
});

/**
 * Resume `runId` for what it is owed (a message, a person's answer), as
 * the run that can: itself, or the parent whose open call owns it, which
 * reattaches it. Answers the run an activation is now in for, or the
 * refusal.
 */
export const resumeOwner = (
  runId: RunId,
): Effect.Effect<
  { readonly activated: RunId } | { readonly failed: ResumeRefusal },
  Error,
  RunRegistry
> =>
  Effect.flatMap(resumeRun(runId, {}), (answer) => {
    if ('ownedBy' in answer) return resumeOwner(answer.ownedBy);
    return Effect.succeed('failed' in answer ? answer : { activated: runId });
  });

/**
 * Resume `runId` for the input it holds (a wake, an interrupted task), with
 * no caller to hand the run to: a refused wake is logged, and the queued
 * row waits for the next explicit resume; an owning parent is followed; a
 * run the store no longer holds is not resumed. Never fails.
 */
const wakeRun = Effect.fn('wakeRun')(function* (
  runId: RunId,
): Effect.fn.Return<void, never, RunRegistry | SessionLog> {
  // The store's answer, not the view's: the view trails the log, and a run
  // it has not applied yet would lose its wake.
  const facts = yield* (yield* SessionLog)
    .facts(runId)
    .pipe(
      Effect.catch((error) =>
        logFailure(
          CHANNEL,
          `Cannot read whether ${runId} still exists`,
        )(error).pipe(Effect.as(null)),
      ),
    );
  if (facts === null) return;
  const resumed = yield* Effect.exit(resumeOwner(runId));
  if (Exit.isFailure(resumed)) {
    if (Cause.hasInterruptsOnly(resumed.cause)) return;
    yield* Effect.logError(`Failed to resume run ${runId}`).pipe(
      Effect.annotateLogs({ data: resumed.cause }),
      withLogChannel(CHANNEL),
    );
    return;
  }
  const answer = resumed.value;
  // A run a launch here holds reads its input itself: nothing to say.
  if ('failed' in answer && (yield* RunRegistry).get(runId) === undefined)
    yield* Effect.logWarning(
      `Run ${runId} was not resumed for its input: ${describeRefusal(answer.failed)}`,
    ).pipe(withLogChannel(CHANNEL));
});

/** What a run's input rows refused a send for, as its sender is told. */
const REFUSED_SEND = {
  closed: describeRefusal({ kind: 'notResumable' }),
  stopped:
    "Its user stopped this run, and only the user's own message continues it.",
} as const satisfies Record<
  Extract<SendVerdict, { kind: 'refused' }>['reason'],
  string
>;

/** Resume the run if its input obliges one (`SessionInbox.owesResume`) and
 *  no fiber here drives it (one that does reads its input itself, and is
 *  woken as it leaves), on the session's own fibers: the sender hears
 *  nothing of the resume, and a resume asked meanwhile joins it. */
export const wakeIfOwed = Effect.fn('wakeIfOwed')(function* (
  runId: RunId,
  apiKeys: Readonly<Record<string, string>> = {},
): Effect.fn.Return<void, never, Inbox | RunRegistry> {
  const runs = yield* RunRegistry;
  const owed = yield* (yield* Inbox).owesResume(runId);
  if (owed !== true || runs.get(runId) !== undefined) return;
  // The wake's own keys, never the fiber's: the sender may be another
  // client's run, whose keys this run must never take.
  runs.background(
    wakeRun(runId).pipe(Effect.provideService(LaunchKeys, apiKeys)),
  );
});

/**
 * Wait for the notes `runId` wrote to itself, when no fiber here drives it,
 * and resume it ({@link wakeIfOwed}) as each one's time comes. The wait is
 * the run's one wake timer on the session's own fibers
 * (`RunRegistry.wakeTimer`): a later call replaces it, so whoever changes a
 * run's notes calls this again; the run's start ends it, since a run a
 * fiber drives waits for its notes in its own reader, and its leaving
 * calls this again. The session's close ends it too, and its next open
 * starts it again ({@link wakePendingNotes}), when a note already due is
 * read late, and once.
 */
export const waitForWakeNotes = Effect.fn('waitForWakeNotes')(function* (
  runId: RunId,
): Effect.fn.Return<void, never, RunRegistry> {
  const runs = yield* RunRegistry;
  if (runs.get(runId) !== undefined) return;
  runs.wakeTimer(
    runId,
    Effect.gen(function* () {
      const inbox = yield* Inbox;
      // The due time woken for last: a note due then or before was read by
      // the resume it started, or waits for the run's next one.
      let woken = -Infinity;
      for (;;) {
        const later = wakeNotes((yield* inbox.read(runId)).followUps)
          .map(({ due }) => due)
          .filter((due) => due > woken);
        if (later.length === 0) return;
        woken = Math.min(...later);
        yield* sleepUntil(woken);
        yield* wakeIfOwed(runId);
      }
    }).pipe(
      Effect.catch(
        logFailure(
          CHANNEL,
          `Run ${runId}: its wake notes could not be read; each is delivered at its next resume`,
        ),
      ),
    ),
  );
});

/**
 * The notes runs wrote to themselves that an earlier process left pending,
 * waited for here ({@link waitForWakeNotes}): one already due resumes its
 * run at once. Run once as a session opens, for each run the view lists
 * with a queued message, a note among them; the timer reads which are
 * notes from the run's own input rows.
 */
export const wakePendingNotes: Effect.Effect<
  void,
  never,
  RunRegistry | SessionViewAccess
> = Effect.gen(function* () {
  const { runs } = yield* (yield* SessionViewAccess).read([]);
  for (const run of runs.values())
    if (run.queuedFollowUps.length > 0) yield* waitForWakeNotes(run.id);
});

/**
 * The one acceptance of a message to a run: every host and tool sends
 * through here. The run's input rows decide the send in the job that
 * commits it (`sendVerdict`), so the row is durable before anything is
 * acknowledged or woken; then the run is woken if the row obliges it and
 * no fiber here drives it (`wakeIfOwed`), a run's own note for a later
 * time when that time comes (`waitForWakeNotes`).
 *
 * A run a fiber here drives reads the row itself, at its next request or
 * turn boundary; a child that ends with it queued is resumed for it. With
 * none here, the persisted facts decide: the run's records whether it can
 * continue (a state that cannot be read cannot), and its input rows
 * whether this message is queued and wakes it.
 */
export const submitFollowUp = Effect.fn('submitFollowUp')(function* (
  runId: RunId,
  item: InboxItem,
  options: SubmitFollowUpOptions,
): Effect.fn.Return<SubmitFollowUpResult, Error, FollowUpServices> {
  const { hold, prepare, apiKeys, skills } = options;
  const inbox = yield* Inbox;
  const runs = yield* RunRegistry;
  const log = yield* SessionLog;
  const view = yield* SessionViewAccess;
  const failed = (message: string) => ({ status: 'failed', message }) as const;
  // From the checks to the row's commit, one send to a run at a time, so a
  // run's messages commit in call order; the wake runs after, so a send that
  // resumes the run does not hold later sends for the resumed turn.
  const sent = yield* Effect.gen(function* () {
    // A run that takes no input (a process run, a one-shot root) reads
    // none, live or resumed: nothing would read the row.
    // The view answers, not the store: a run the view has not loaded skips
    // this check, because the store's answer would refuse every ended
    // one-shot root, and a later resume of one does read a message sent to
    // it (`example/10-external-plugin.ts`).
    const target = view.run(runId);
    if (target?.takesFollowUps === false)
      // A fork is offered only to a run that has one (`RunView.actions`):
      // a background command or an agent CLI's turn cannot be forked.
      return failed(
        `This run ran once and takes no messages. ${
          target.actions.includes('fork')
            ? 'Continue it as a fork, or start'
            : 'Start'
        } a new agent task.`,
      );
    const live = runs.get(runId);
    if (live === undefined) {
      const rejection = yield* checkpointRefusal(runId).pipe(
        Effect.catch((error) =>
          logFailure(
            CHANNEL,
            `Cannot read whether ${runId} can continue`,
          )(error).pipe(Effect.as({ kind: 'readFailed' } as const)),
        ),
      );
      if (rejection !== null) return failed(describeRefusal(rejection));
    }
    // A message to a run that is stopping is decided after the stop: its
    // verdict and its wake read the run's end (a user's continues the run,
    // another run's is refused).
    if (live !== undefined) {
      const facts = yield* log.facts(runId);
      if (facts?.stop !== null && facts?.end === null) yield* live.drained;
    }
    const prepared = prepare === undefined ? {} : yield* prepare;
    const verdict = yield* inbox.send(
      runId,
      { ...item, ...prepared },
      { hold, skills },
    );
    if (verdict.kind === 'refused') return failed(REFUSED_SEND[verdict.reason]);
    // A replay was accepted before; a new row reached a running loop, or
    // waits for the run's resume.
    const reaches = verdict.kind === 'replay' || live !== undefined;
    return { status: reaches ? 'sent' : 'queued' } as const;
  }).pipe(withPerKeyLane(inbox.sendLanes, runId));
  // After the commit: a run a fiber drove a moment ago may have left
  // meanwhile.
  if (sent.status === 'failed') return sent;
  yield* wakeIfOwed(runId, apiKeys);
  if (item.from.kind === 'self') yield* waitForWakeNotes(runId);
  return sent;
});

/**
 * One run's input, as a plugin reaches it: what it sends the run (routed,
 * accepted and woken as {@link submitFollowUp} does), and when the run
 * takes no more.
 */
export interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
}

/** `runId`'s input on the session whose services are `session`
 *  ({@link FollowUpServices}). */
export const runInbox = (
  runId: RunId,
  session: Context.Context<FollowUpServices>,
): RunInbox => ({
  send: (item) => submitFollowUp(runId, item, {}).pipe(Effect.provide(session)),
  onClosed: (listener) =>
    Context.get(session, Inbox).onClosed((closed) => {
      if (closed.kind === 'session' || closed.runId === runId) listener();
    }),
});
