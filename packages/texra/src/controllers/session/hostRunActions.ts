/** Host-neutral relaunch and retry actions shared by extension and desktop. */

import * as path from 'node:path';

import type {
  LaunchError,
  Run,
  RunFailure,
  Session,
  StartInput,
  WorkspaceRoots,
  Notices,
} from '@texra-ai/worldline';
import {
  type ProcessServices,
  type readModelOptions,
  presentRunFailure,
  workspaceEnvironmentLayer,
  programLaunch,
} from '@texra-ai/worldline/host';
import {
  logFailure,
  withLogChannel,
  StateReadFailed,
} from '@texra-ai/worldline/plugins';
import { Effect, Scope } from 'effect';

import {
  labelFileName,
  toErrorMessage,
  runActionRefusal,
  type RunAction,
  type RunId,
  Cancelled,
  Rejected,
  Unavailable,
  type RequestError,
} from '@texra-ai/worldline/schemas';
import { DEFAULT_AGENT_MODEL } from '@texra/model/curatedModels';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import { forkRun, resumeRun } from '@texra/controllers/session/runActionPolicy';
import { PACKED_RUNS_DIRECTORY } from '@texra/common/files/fileHandlingRules';
import { fileNameTimestamp } from '@housekeeping/artifactFiles';
import { modelFileName } from '@texra/utils/files/outputFileUtils';
import {
  documentRoundsOf,
  isDocumentTaskRun,
  MERGE_EDITED_FILE,
} from '@texra/shared/plugins/documents';
import type { Dialogs, HostFailed } from '@texra/hosts/uiHosts';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import { selectAutoOpenFinalOutput } from '@texra/agent/output/selectAutoOpenFinalOutput';

import {
  planCompileFixer,
  type CompileFixerPlanFailed,
} from '@texra/agent/output/compileFixer';
import type {
  AgentConfig,
  AgentConfigInput,
} from '@texra-ai/worldline/schemas';
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

/** What reading the model options fails with: what its reads fail with. */
type ModelOptionsUnreadable = Effect.Error<ReturnType<typeof readModelOptions>>;

export interface HostRunActionPorts {
  /** The window's roots: its workspace and its settings stores. */
  readonly roots: WorkspaceRoots;
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
  /** Show a finished run's final output, the file at `absolutePath`. */
  openFinalOutput(absolutePath: string): Effect.Effect<void, Error>;
  /** The window's notices. */
  notify: Dialogs['notify'];
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
  /** Merge `editedFile` into `baseFile`: the `merge` program on the helper
   *  model, answering once its run is started. */
  merge(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, RequestRefusal | StateReadFailed, ProcessServices>;
  resume(runId: RunId): Effect.Effect<void, RequestRefusal, ProcessServices>;
  /** The saved setup Run again… opens the launch form on. */
  runAgain(runId: RunId): Effect.Effect<AgentConfig, RequestRefusal>;
  runCompileFixer(
    runId: RunId,
  ): Effect.Effect<
    void,
    | CompileFixerPlanFailed
    | ModelOptionsUnreadable
    | StateReadFailed
    | HostFailed
    | RequestRefusal
    | RunFailure,
    ProcessServices
  >;
  /** Pack or clean a document task run's files, from its saved config, and
   *  say what it did: the session's `run.files`, which the process that
   *  holds the run does with it held. A run that is not a document task's,
   *  or saved no config, is `Rejected`. */
  documentTaskFileOperation(
    runId: RunId,
    operation: 'pack' | 'clean',
  ): Effect.Effect<void, RequestError | Unavailable>;
  /** A new task holding the run's conversation up to `at` (its latest
   *  finished point when absent), continued here so it takes a message:
   *  the fork's id. */
  fork(
    runId: RunId,
    at: number | undefined,
  ): Effect.Effect<RunId, RequestRefusal, ProcessServices>;
  /** Send `text` to the conversation that launched `runId` (the chat that
   *  called a document task), past any background script it ran under; a
   *  run nothing launched has no one to send it to. */
  followUpLauncher(runId: RunId, text: string): Effect.Effect<void>;
}

export const createHostRunActions = Effect.fn(
  'hostRunActions.createHostRunActions',
)(function* (
  ports: HostRunActionPorts,
): Effect.fn.Return<HostRunActions, never, Scope.Scope> {
  // What an action does when its run ends lives as long as the window.
  const scope = yield* Scope.Scope;
  const { roots, session } = ports;
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
  /** When a run this window started ends, the final output of the documents
   *  it recorded opens. Presentation reacts to the outcome the run committed; it never
   *  runs inside the run, so it cannot change that outcome. Its documents
   *  are read from the store, which holds the run's rows once its end is
   *  read, whichever process the window's view follows. */
  const whenEnded = (run: Run) =>
    Effect.gen(function* () {
      const result = yield* run.result;
      const stored = yield* session.view.read([]);
      const output = yield* selectAutoOpenFinalOutput(
        roots,
        result,
        stored.runs.get(run.runId),
      );
      if (output) yield* ports.openFinalOutput(output.absolutePath);
    }).pipe(Effect.ignore({ log: 'Warn', message: 'Opening the output' }));
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
      Effect.tap((run) => Effect.forkIn(whenEnded(run), scope)),
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
  /** Start the configuration an action built: one that does not decode is
   *  rejected before anything starts, and one that does not start is
   *  `Cancelled`, the answer no surface shows, since the launcher has
   *  already told why. */
  const startAgentRequest = (
    config: AgentConfigInput,
    options?: RunValidatedOptions,
  ): Effect.Effect<Run, Rejected | Cancelled, ProcessServices> =>
    decodeLaunchConfig(config).pipe(
      Effect.flatMap((decoded) =>
        runValidated(decoded, options).pipe(
          Effect.mapError(() => new Cancelled()),
        ),
      ),
    );
  /** The saved config of a document task's run. `files` holds on every
   *  finished run, so a request on a run that saved no config, or that is
   *  not a document task's, is refused here, which the surface presents. */
  const savedTaskConfig = Effect.fn('HostRunActions.savedTaskConfig')(
    function* (runId: RunId) {
      const config = yield* readConfig(runId);
      if (!config)
        return yield* new Rejected({
          reason: 'This run saved no setup to act on.',
        });
      const run = runView(runId);
      if (run === undefined || !isDocumentTaskRun(run))
        return yield* new Rejected({
          reason: 'This action applies to a document task.',
        });
      return config;
    },
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
        reason: "This run's configuration was not saved.",
      });
    }
    return config;
  });

  return {
    followUpLauncher(runId, text) {
      // A background script replays its recorded program and reads no new
      // input, so the note goes to the conversation that started the script.
      let launcher = runView(runId)?.launch?.id ?? null;
      for (
        let parent = launcher === null ? undefined : runView(launcher);
        parent?.identity.kind === 'script';
        parent = launcher === null ? undefined : runView(launcher)
      )
        launcher = parent.launch?.id ?? null;
      if (launcher === null) return Effect.void;
      const present = (message: string) => ports.notify('warning', message);
      const deliver = session
        .request({ kind: 'followUp.send', runId: launcher, text })
        .pipe(
          // A refused send is an `Unavailable` error, presented below; the
          // success value (queued or sent) says nothing to the launcher.
          Effect.catchCause((cause) => {
            const message = toErrorMessage(cause);
            return Effect.logWarning(
              `Failed to send a follow-up to run ${launcher}: ${message}`,
            ).pipe(
              Effect.annotateLogs({
                data: { runId: launcher, error: message },
              }),
              withLogChannel(CHANNEL),
              Effect.andThen(
                present(`Could not send the follow-up: ${message}`),
              ),
              Effect.ignore({ log: 'Warn' }),
            );
          }),
        );
      // Detached: the follow-up can wake the launcher for a whole model
      // turn, so no host request waits on the outcome.
      return Effect.forkDetach(deliver).pipe(Effect.asVoid);
    },
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
    merge: Effect.fn('HostRunActions.merge')(function* (baseFile, editedFile) {
      const inputFiles = [baseFile];
      const launch = yield* programLaunch(
        'merge',
        { [MERGE_EDITED_FILE]: editedFile },
        { inputFiles, outputFiles: [] },
        roots,
      ).pipe(
        // No merge program is registered: said beside the merge docs, and
        // logged.
        Effect.catchTag('ProgramNotRegistered', ({ message }) =>
          Effect.logWarning(message).pipe(
            withLogChannel(CHANNEL),
            Effect.andThen(
              ports.present.emit('requestShowError', {
                message,
                docsPage: 'intelligent-merge',
              }),
            ),
            Effect.as(null),
          ),
        ),
      );
      // The helper model while it can serve, as every helper launch decides
      // (`helperModel`), else the default agent model.
      if (launch !== null)
        yield* startAgentRequest(
          { ...launch, model: DEFAULT_AGENT_MODEL, inputFiles },
          { helperModel: true },
        );
    }),
    documentTaskFileOperation: Effect.fn(
      'HostRunActions.documentTaskFileOperation',
    )(function* (runId, operation) {
      // `run.files` is gated and held by the session's request handler.
      const config = yield* savedTaskConfig(runId);
      const inputFile = config.inputFiles[0] ?? '';
      // A pack names its folder for the input; a clean needs none.
      if (operation === 'pack' && !inputFile)
        return yield* new Rejected({
          reason: 'Select an input file before packing.',
        });
      const outcome = yield* session
        .request({
          kind: 'run.files',
          runId,
          files:
            operation === 'pack'
              ? {
                  op: 'copy',
                  // A folder under `History/` named for the input, agent
                  // and model, with a run id fragment so two runs packed
                  // within the same second (the timestamp's granularity)
                  // don't collide.
                  to: path.posix.join(
                    PACKED_RUNS_DIRECTORY,
                    `${yield* fileNameTimestamp}_${path.parse(inputFile).name}_${labelFileName(config.label)}_${modelFileName(config.model)}_${runId.replaceAll('-', '').slice(0, 8)}`,
                  ),
                }
              : { op: 'remove' },
        })
        .pipe(
          Effect.catchTag('RunActive', () =>
            Effect.fail(
              new Rejected({
                reason: 'This run is running or held elsewhere.',
              }),
            ),
          ),
        );
      const { result } = outcome;
      switch (result.status) {
        case 'error':
          return yield* new Rejected({
            reason: `Error during ${operation === 'pack' ? 'packing' : 'cleaning'}: ${result.error}`,
          });
        case 'noFiles':
          return yield* ports.notify(
            'info',
            `No files found to ${operation} for ${inputFile}`,
          );
        case 'done':
          return yield* ports.notify(
            'info',
            operation === 'clean'
              ? `Cleanup complete for ${inputFile}`
              : result.to
                ? `Files packed into ${result.to}`
                : 'Files packed.',
          );
      }
    }),
    runCompileFixer: Effect.fn(function* (runId) {
      if (!view().runs.has(runId)) {
        return yield* new Unavailable({
          runId,
          reason: 'The run is no longer open.',
        });
      }
      const config = yield* readConfig(runId);
      const modelOptions = yield* loadModelOptions(roots).pipe(
        Effect.provide(workspaceEnvironmentLayer(roots.workspace)),
      );
      // A document task's rounds, as the view holds them once the reads
      // above are done.
      const run = runView(runId);
      const fixer = yield* planCompileFixer({
        runId,
        runConfig: config,
        rounds:
          run !== undefined && isDocumentTaskRun(run)
            ? documentRoundsOf(run)
            : undefined,
        modelOptions,
        workspaceRoot: roots.workspace,
      });
      // The fixer's run is waited for to its end.
      const fixing = yield* startAgentRequest(fixer, { helperModel: true });
      yield* fixing.result;
    }),
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
