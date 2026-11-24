/** Host-neutral relaunch and retry actions shared by extension and desktop. */

import type {
  LaunchError,
  Run,
  RunFailure,
  Session,
  StartInput,
  Notices,
} from '@texra-ai/worldline';
import {
  type ProcessServices,
  presentRunFailure,
} from '@texra-ai/worldline/host';
import { logFailure } from '@texra-ai/worldline/plugins';
import { Effect, Scope } from 'effect';

import {
  toErrorMessage,
  runActionRefusal,
  type RunAction,
  type RunId,
  Cancelled,
  Rejected,
  Unavailable,
} from '@texra-ai/worldline/schemas';
import { forkRun, resumeRun } from '@texra/controllers/session/runActionPolicy';
import type { AgentConfig } from '@texra-ai/worldline/schemas';
import {
  isRequestRefusal,
  type RequestRefusal,
} from '@texra/controllers/session/hostCallFailure';

const CHANNEL = 'HostRunActions';

/** The launch facts an action adds to a validated request, as the
 *  session's `start` takes them: the run's id when the host minted it, and
 *  the run a chat's new round continues. */
type RunValidatedOptions = Pick<
  StartInput,
  'helperModel' | 'approval' | 'runId' | 'continues'
>;

export interface HostRunActionPorts {
  /** Where a failure before a run opens is presented. */
  readonly present: Notices;
  /** Bring the host's progress surface into view for a run this window just
   *  started, or name the run in a notice when it cannot; a host whose
   *  surface is always on screen does nothing. */
  readonly revealProgress: (config: AgentConfig) => Effect.Effect<void, Error>;
  /** Where this window's run actions land: its own session, or the
   *  background service's. Run state is read from its view, a run's saved
   *  setup from its records. */
  readonly session: Session;
  /** The window's follow-up for a run it started, once started: show the
   *  run once its surfaces hold it, and retire the missing-agent banner its
   *  agent resolved. */
  launched(run: Run): Effect.Effect<void>;
}

/** What a host's request handlers do once {@link createHostRunActions} has bound
 *  that host's launcher, catalogs, key prompt, and notifications. */
export interface HostRunActions {
  /**
   * The window's launcher: start a fresh run of an already decoded
   * configuration (`decodeLaunchConfig`) on its session, answering once it
   * is started; it decodes nothing itself. A failure before the run opens is
   * logged and presented here, once, and fails with the launch's own error,
   * which the caller does not present again (a request answers `Cancelled`);
   * the launched run is the window's to show (`launched`), and its final
   * output opens when it ends.
   */
  runValidated(
    config: AgentConfig,
    options?: RunValidatedOptions,
  ): Effect.Effect<Run, LaunchError | RunFailure, ProcessServices>;
  resume(runId: RunId): Effect.Effect<void, RequestRefusal, ProcessServices>;
  /** The saved setup Run again… opens the launch form on. */
  runAgain(runId: RunId): Effect.Effect<AgentConfig, RequestRefusal>;
  /** A new task holding the run's conversation up to `at` (its latest
   *  finished point when absent), continued here so it takes a message:
   *  the fork's id. */
  fork(
    runId: RunId,
    at: number | undefined,
  ): Effect.Effect<RunId, RequestRefusal, ProcessServices>;
}

export const createHostRunActions = Effect.fn(
  'hostRunActions.createHostRunActions',
)(function* (
  ports: HostRunActionPorts,
): Effect.fn.Return<HostRunActions, never, Scope.Scope> {
  // What an action does when its run ends lives as long as the window.
  const scope = yield* Scope.Scope;
  const { session } = ports;
  const view = () => session.view.current();
  const runView = (runId: RunId) => view().runs.get(runId);
  /** The run's `actions` must still hold `action` as the request is
   *  handled, not only as it was rendered; a run the view no longer holds
   *  is left to the action's own read. A second Resume joins the first in
   *  the session; a pack or clean is held by the session (`run.files`). */
  const requireAction = (
    runId: RunId,
    action: RunAction,
  ): Effect.Effect<void, Rejected> =>
    Effect.suspend(() => {
      const run = runView(runId);
      return run === undefined || run.actions.includes(action)
        ? Effect.void
        : Effect.fail(new Rejected({ reason: runActionRefusal(run, action) }));
    });
  /** A run's saved setup, from the session that holds it; undefined when
   *  it saved none. One the session cannot read refuses the action. */
  const readConfig = (
    runId: RunId,
  ): Effect.Effect<AgentConfig | undefined, Unavailable> =>
    session.records(runId).readConfig.pipe(
      Effect.map((config) => config ?? undefined),
      Effect.mapError(
        (cause) =>
          new Unavailable({
            runId,
            reason: `Its saved setup could not be read: ${toErrorMessage(cause)}`,
          }),
      ),
    );
  /**
   * Every run this window starts, resumes or forks: a launch that fails
   * before its run opens has no row to show it, so it is logged and shown
   * here, once, by the notice it carries; a request refusal (a resume the
   * run does not take) is the surface's to word, so it passes through. The
   * launched run is the window's (`launched`), and what follows its end is
   * forked into the window's scope. The failure still fails the action,
   * which no caller presents again.
   */
  const launch = <E>(
    start: Effect.Effect<Run, E, ProcessServices>,
  ): Effect.Effect<Run, E, ProcessServices> =>
    start.pipe(
      Effect.tapError((error) =>
        isRequestRefusal(error)
          ? Effect.void
          : logFailure(
              CHANNEL,
              'A run did not start',
            )(error).pipe(
              Effect.andThen(presentRunFailure(ports.present, error)),
            ),
      ),
      Effect.tap(ports.launched),
    );
  const runValidated: HostRunActions['runValidated'] = (config, options) =>
    launch(session.start({ config, ...options, interactive: true })).pipe(
      // The reveal, and the toast it falls back to, outlive the launch
      // request: nothing waits on a person dismissing a notice, and a failed
      // reveal is a diagnostic for a run already started.
      Effect.tap(() =>
        Effect.forkIn(
          ports.revealProgress(config).pipe(
            Effect.ignore({
              log: 'Warn',
              message: 'Revealing the progress view',
            }),
          ),
          scope,
        ),
      ),
    );
  /** A run the launcher can relaunch: a TeXRA agent with a saved config. */
  const nativeAgentRun = Effect.fn('HostRunActions.nativeAgentRun')(function* (
    runId: RunId,
    action: 'resume' | 'runAgain',
  ) {
    yield* requireAction(runId, action);
    const config = yield* readConfig(runId);
    if (!config) {
      return yield* new Rejected({
        reason: 'This task has no saved configuration.',
      });
    }
    return config;
  });

  return {
    /**
     * Resume a finished run, of either category, on the session that holds
     * it: it continues the run's own rows (a child's, with the parent
     * that owns it). A run that does not take it refuses the request with
     * its reason, a missing agent or plugin included; one whose launch
     * fails is told by {@link launch}, so the request answers `Cancelled`.
     */
    resume: Effect.fn('HostRunActions.resume')(function* (runId) {
      yield* nativeAgentRun(runId, 'resume');
      yield* launch(resumeRun(session, runId)).pipe(
        Effect.catchTag(['RunFailure', 'LaunchRefused'], () =>
          Effect.fail(new Cancelled()),
        ),
      );
    }),
    runAgain: (runId) => nativeAgentRun(runId, 'runAgain'),
    runValidated,
    fork: Effect.fn('HostRunActions.fork')(function* (runId, at) {
      const forked = yield* forkRun(session, runId, at);
      // The fork waits for its host: continuing it waits on the user's
      // next message. A failed continuation is told by `launch` and leaves
      // the fork its Resume; the fork stands either way.
      yield* launch(resumeRun(session, forked)).pipe(
        Effect.ignore({ log: 'Warn' }),
      );
      return forked;
    }),
  };
});
