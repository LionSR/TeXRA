import { computed, signal } from '@lit-labs/signals';
import { Deferred, Effect } from 'effect';

import {
  isInterrupted,
  type RunId,
  type RunView,
} from '@texra-ai/harness/schemas';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/headless/terminalStatus';

import {
  registerCliStateResetHook,
  rootRunId,
  sessionViewFailure,
} from './cliState';
import { runViewOf, sessionView } from './sessionView';

/**
 * The chat's latest root launch: a fresh run or a resume, from the moment it
 * is asked for until the session holds its run. Once the session holds it,
 * `rootRunId` names the run and the session view says how it stands; a
 * launch that ended without a run keeps the code the chat then exits with.
 * Held in a signal, not in `TuiSession` fields, so renders read it
 * reactively instead of calling impure session closures that memoized
 * renders would cache stale (#8273).
 */
interface RootLaunch {
  /** Done once the session holds the launch's run, with its id, or the
   *  launch ended without one, with null: a stop asked meanwhile waits for
   *  it, then lands on the root the chat holds, and a message typed
   *  meanwhile goes to that run. */
  readonly launched: Deferred.Deferred<RunId | null>;
  /** For a launch that ended without a run: the code the chat exits with
   *  unless a later root replaces it (a refused resume is a usage error, a
   *  failed launch an agent error, a resume with no run a success). */
  readonly exitCode: CliExitCode | undefined;
}

/** How a root launch ended: the session holds its run, or it has none and
 *  the chat exits with `exitCode`. */
type LaunchEnd = { readonly runId: RunId } | { readonly exitCode: CliExitCode };

/** How the chat leaves, once decided: on its own (`/exit`, a Ctrl-C with
 *  nothing to stop), or on a signal with that signal's exit code. */
export type ChatExit =
  | { readonly kind: 'graceful' }
  | { readonly kind: 'signal'; readonly exitCode: number };

const rootLaunch = signal<RootLaunch | undefined>(undefined);
registerCliStateResetHook(() => rootLaunch.set(undefined));

/** The launch still on its way to the session, if one is. */
const launchInFlight = (): RootLaunch | undefined => {
  const launch = rootLaunch.get();
  return launch !== undefined && !Deferred.isDoneUnsafe(launch.launched)
    ? launch
    : undefined;
};

/** The chat's root run as the session view shows it. */
const rootRun = (): RunView | undefined =>
  runViewOf(sessionView().get(), rootRunId.get());

/** The root waits between turns in a launch the session holds. */
const rootWaiting = (): boolean => {
  const root = rootRun();
  return (
    launchInFlight() === undefined &&
    root?.holder === 'here' &&
    root.position === 'waiting'
  );
};

/** Whether a Ctrl-C stops the root run: a launch on its way, or a root the
 *  session holds that is not waiting between turns. Read by the SIGINT
 *  handler, the status bar's Ctrl-C hint and the terminal title. */
export const canStopRootRun = computed((): boolean => {
  if (launchInFlight() !== undefined) return true;
  const root = rootRun();
  return root?.holder === 'here' && root.position !== 'waiting';
});

/**
 * Root-run state of one chat TUI session: the launch in {@link rootLaunch},
 * and the run-control questions the exit paths and slash commands ask, read
 * live from it and the session view.
 */
export class TuiSession {
  private readonly runsElsewhere: boolean;

  /** A new session starts with no launch. `runsElsewhere`: its runs run in
   *  the background service, so leaving the chat never ends one. */
  constructor(runsElsewhere = false) {
    this.runsElsewhere = runsElsewhere;
    rootLaunch.set(undefined);
  }

  /** The chat's one exit, once an exit path decided it: its result is the
   *  code the chat ends with. While it is set the chat is leaving: a message
   *  typed now goes back to the input, and a run that fails now says
   *  nothing. */
  exited: Promise<CliExitCode> | undefined;

  /** The chat's exit code: a dead session view is a failure on every exit
   *  path; then a launch that ended without a run says it; otherwise the
   *  root run's outcome does, and a root whose end was lost (interrupted
   *  with nothing driving it) is a failure. */
  get exitCode(): CliExitCode {
    if (sessionViewFailure.get() !== undefined) return CliExitCode.AgentError;
    const launched = rootLaunch.get()?.exitCode;
    if (launched !== undefined) return launched;
    const root = rootRun();
    if (root === undefined) return CliExitCode.Success;
    if (isInterrupted(root)) return CliExitCode.AgentError;
    return root.outcome === null
      ? CliExitCode.Success
      : runOutcomeExitCode(root.outcome);
  }

  /** The launch on its way to the session: what a stop waits for. */
  get launched(): Deferred.Deferred<RunId | null> | undefined {
    return launchInFlight()?.launched;
  }

  /** No launch is on its way and the session holds no root of the chat:
   *  a message starts a fresh run, and the agent can change. */
  canStartRootRun(): boolean {
    return launchInFlight() === undefined && rootRun()?.holder !== 'here';
  }

  /**
   * Claim the root launch: the check that no root run is in flight and the
   * claim are one synchronous step, so no other launch, resume or taken-up
   * root lands between them, and a message typed while the claimant still
   * chooses its model already sees it. Undefined when a root run is in
   * flight. The claimant ends it with {@link endLaunch}.
   */
  claimLaunch(): Deferred.Deferred<RunId | null> | undefined {
    if (!this.canStartRootRun()) return undefined;
    const launched = Deferred.makeUnsafe<RunId | null>();
    rootLaunch.set({ launched, exitCode: undefined });
    return launched;
  }

  /** The launch `launched` reached its end: the session holds its run,
   *  which becomes the chat's root, or it has none. Only its first end
   *  counts, and only while it is still the chat's latest launch. */
  endLaunch(launched: Deferred.Deferred<RunId | null>, end: LaunchEnd): void {
    if (Deferred.isDoneUnsafe(launched)) return;
    if (rootLaunch.get()?.launched === launched) {
      if ('runId' in end) rootRunId.set(end.runId);
      // A new record, so renders that read whether the launch is on its
      // way see that it is not.
      rootLaunch.set({
        launched,
        exitCode: 'exitCode' in end ? end.exitCode : undefined,
      });
    }
    // Last: the fibers waiting on the launch resume inside this call, and
    // they read the root it names.
    Deferred.doneUnsafe(
      launched,
      Effect.succeed('runId' in end ? end.runId : null),
    );
  }

  /** The root `runId`'s result could not be read (its connection died, or
   *  its end was lost): the chat exits as a failure, unless a later root
   *  replaces it, whatever a view that stopped updating still shows. A
   *  launch on its way is that later root, so it is left to end. */
  rootFailed(runId: RunId): void {
    if (rootRunId.get() !== runId || launchInFlight() !== undefined) return;
    const launched = Deferred.makeUnsafe<RunId | null>();
    Deferred.doneUnsafe(launched, Effect.succeed(runId));
    rootLaunch.set({ launched, exitCode: CliExitCode.AgentError });
  }

  /** A root the session resumed on its own becomes the chat's, unless a
   *  launch is on its way or another root of the chat is live here: either
   *  is newer than the resume and keeps the chat. Taken up, it replaces the
   *  latest launch, whose end no longer decides the exit. Answers whether it
   *  was taken up. */
  takeUpRoot(runId: RunId): boolean {
    if (launchInFlight() !== undefined) return false;
    const root = rootRun();
    if (root !== undefined && root.id !== runId && root.holder === 'here')
      return false;
    rootLaunch.set(undefined);
    rootRunId.set(runId);
    return true;
  }

  /** Model selection is open with no root in flight, or while the root
   *  waits between turns, where the switch reaches the live run. */
  canSelectModel(): boolean {
    return this.canStartRootRun() || rootWaiting();
  }

  /**
   * On exit, a tool-use session suspended at a wait (idle/WAITING) is not
   * stopped the way a Ctrl-C stops a turn: the user's stop policy
   * (`detachSubagentsOnStop`) does not apply, and the exit needs no second
   * Ctrl-C. The session's close still ends the generation, which records its
   * terminal `run.end` as cancelled ("Stopped"): every activation ends with
   * one, and a run left without it would read as interrupted by a crash.
   * Resumability survives either way: a run's rows stay until the run is
   * explicitly deleted.
   */
  isResumableIdle(): boolean {
    // The service holds the task: the chat leaves it as it is, any time.
    return this.runsElsewhere || rootWaiting();
  }
}
