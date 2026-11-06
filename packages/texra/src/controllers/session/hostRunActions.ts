/** Host-neutral relaunch and retry actions shared by extension and desktop. */

import {
  Cancelled,
  Rejected,
  type RequestError,
  type RequestRefusal,
  type Run,
  type RunEnd,
  type RunFailure,
  type Session,
  type StartInput,
  Unavailable,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import {
  AgentCatalog,
  getHelperModelName,
  type ModelHostFactUnreadable,
  StateReadFailed,
  withLogChannel,
  launchNoticeOf,
  presentFollowUpResult,
  presentRunFailure,
  type SessionHostInteractions,
} from '@texra-ai/harness/host';
import { Cause, Effect, FileSystem, Schema, type Scope } from 'effect';

import {
  toErrorMessage,
  isTaskConfig,
  recipeBlockOf,
  RunIdSchema,
  runActionRefusal,
  type RunAction,
  type RunId,
} from '@texra-ai/harness/schemas';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import { forkRun, resumeRun } from '@texra/controllers/session/runActionPolicy';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { packDestination } from '@texra/tools/documents/runOutputs';
import type { FileOpResult } from '@texra/shared/session/hostRequest';
import {
  DOCUMENT_TASK_BLOCK,
  documentsOf,
} from '@texra/shared/plugins/documents';
import type { MessageHost, NotificationFailed } from '@texra/hosts/uiHosts';

import {
  planCompileFixer,
  type CompileFixerPlanFailed,
} from '../progressView/compileFixer';
import type { AgentConfig, AgentConfigInput } from '@texra-ai/harness/schemas';

const CHANNEL = 'HostRunActions';

/** What the workflow toolbar's pack or clean of a run's files did, and the
 *  input file its message names. */
interface WorkflowFileOperationResult {
  readonly result: FileOpResult;
  readonly inputFile: string;
}

/** The run's saved setup could not be read: the database would not answer
 *  or refused the committed `run.config` row, or the service holding the
 *  run could not answer for it (`cause`). */
class RunConfigUnreadable extends Schema.TaggedError<RunConfigUnreadable>()(
  'RunConfigUnreadable',
  { runId: RunIdSchema, message: Schema.String, cause: Schema.Defect() },
) {}

/** The launch facts an action adds to a validated request, as the
 *  session's `start` takes them. */
type RunValidatedOptions = Pick<StartInput, 'helperModel' | 'approval'>;

export interface HostRunActionPorts {
  /** The window's roots: its workspace and its settings stores. */
  readonly roots: WorkspaceRoots;
  /** The run's saved setup, from this process's session where the window
   *  holds it, from the service where it runs there; null when it saved
   *  none. */
  readonly readConfig: (
    runId: RunId,
  ) => Effect.Effect<AgentConfig | null, Error>;
  /** Where a failure before a run opens is presented. */
  readonly present: Pick<SessionHostInteractions, 'emit'>;
  /** Bring the host's progress surface into view for a run this window just
   *  started, or name the run in a notice when it cannot. Absent on a host
   *  whose surface is always on screen. */
  readonly revealProgress?: (config: AgentConfig) => Effect.Effect<void, Error>;
  /** Where this window's run actions land: its own session, or the
   *  background service's. Run state is read from its view. */
  readonly session: Session;
  /** The host's scope: what an action does when its run ends lives as long
   *  as the host. */
  readonly scope: Scope.Scope;
  /** The window's follow-up for a run it started, once admitted: show the
   *  run once its surfaces hold it, and retire the missing-agent banner its
   *  agent resolved. */
  launched(run: Run): Effect.Effect<void>;
  /** Open a settled run's final output, when its agent names one. */
  openFinalOutput(
    config: AgentConfig,
    result: RunEnd,
  ): Effect.Effect<void, Error>;
  loadModelOptions(): Effect.Effect<
    Parameters<typeof planCompileFixer>[0]['modelOptions'],
    ModelHostFactUnreadable | StateReadFailed
  >;
  /** The notification surface, shared with {@link MessageHost}: a host that
   *  could not present fails with `NotificationFailed`, and a user who
   *  ignores the notice is not a failure. */
  showInfo: MessageHost['showInfoMessage'];
  showWarning: MessageHost['showWarningMessage'];
}

/** What a host's request arms do once {@link createHostRunActions} has bound
 *  that host's launcher, catalogs, key prompt, and notifications. */
export interface HostRunActions {
  /**
   * The window's launcher: start a fresh run of an already decoded
   * configuration (`decodeLaunchConfig`) on its session, answering once it
   * is admitted; it decodes nothing itself. A failure before the run opens is
   * logged and presented here, once, and fails with the launch's own error,
   * which the caller does not present again (a request answers `Cancelled`);
   * the launched run is the window's to show (`launched`), and its final
   * output opens when it ends.
   */
  runValidated(
    config: AgentConfig,
    options?: RunValidatedOptions,
  ): Effect.Effect<Run, Error>;
  /** Merge `editedFile` into `baseFile`: the merge agent's document task on
   *  the helper model, answering once its run is admitted. */
  merge(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, RequestRefusal | StateReadFailed>;
  resume(
    runId: RunId,
  ): Effect.Effect<void, RequestRefusal | RunConfigUnreadable>;
  /** The saved setup Run again… opens the launch form on. */
  runAgain(
    runId: RunId,
  ): Effect.Effect<AgentConfig, RequestRefusal | RunConfigUnreadable>;
  runCompileFixer(
    runId: RunId,
  ): Effect.Effect<
    void,
    | CompileFixerPlanFailed
    | ModelHostFactUnreadable
    | StateReadFailed
    | NotificationFailed
    | RequestRefusal
    | RunConfigUnreadable
    | RunFailure
  >;
  /** The toolbar's latexdiff may run: the run still offers `files` and is
   *  a document task's with a saved config; else `Rejected`, which the
   *  surface presents. */
  workflowDiffRequest(
    runId: RunId,
  ): Effect.Effect<void, Rejected | RunConfigUnreadable>;
  /** Pack or clean a workflow run's files, from its saved config: the
   *  action check, then the session's `run.files`, which the process that
   *  holds the run does with it held. A run that is not a document task's,
   *  or saved no config, is `Rejected`. */
  workflowFileOperation(
    runId: RunId,
    operation: 'pack' | 'clean',
  ): Effect.Effect<
    WorkflowFileOperationResult,
    RequestError | RunConfigUnreadable
  >;
  /** A new task holding the run's conversation up to `at` (its latest
   *  settled point when null), continued here so it takes a message: the
   *  fork's id. */
  fork(runId: RunId, at: number | null): Effect.Effect<RunId, RequestRefusal>;
  /** The run's output facts as the view holds them, read by the workflow
   *  controllers. */
  readonly runOutputs: {
    getOutputFiles(runId: RunId): ReturnType<typeof documentsOf>['files'];
  };
  sendFollowUp(runId: RunId, text: string): Effect.Effect<void>;
}

export const createHostRunActions = Effect.fn(
  'hostRunActions.createHostRunActions',
)(function* (
  ports: HostRunActionPorts,
): Effect.fn.Return<
  HostRunActions,
  never,
  FileSystem.FileSystem | AgentCatalog
> {
  // The catalog the merge's task resolves its agent against.
  const catalog = yield* AgentCatalog;
  // Resolved once here and carried: the planner's workspace probes below
  // read through this filesystem rather than taking one from whatever
  // context each of its callers happens to run on.
  const fs = yield* FileSystem.FileSystem;
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
  const runValidated: HostRunActions['runValidated'] = (config, options) =>
    session.start({ config, ...options, interactive: true }).pipe(
      // A failure before the run opens has no row to show it: it is logged
      // and shows here, in this window, by the notice a refused launch
      // carries.
      Effect.tapError((error) =>
        Effect.logWarning(`The ${config.agent} run did not start`).pipe(
          Effect.annotateLogs({ data: error }),
          withLogChannel(CHANNEL),
          Effect.andThen(presentRunFailure(ports.present, error)),
        ),
      ),
      // The reveal, and the toast it falls back to, outlive the launch
      // request: nothing waits on a person dismissing a notice, and a failed
      // reveal is a diagnostic for a run already started.
      Effect.tap(() =>
        Effect.forkIn(
          (ports.revealProgress?.(config) ?? Effect.void).pipe(
            Effect.ignore({
              log: 'Warn',
              message: 'Revealing the progress view',
            }),
          ),
          ports.scope,
        ),
      ),
      Effect.tap(ports.launched),
      // Presentation reacts to the outcome the run committed; it never
      // runs inside the run, so it cannot change that outcome.
      Effect.tap((run) =>
        Effect.forkIn(
          run.result.pipe(
            Effect.flatMap((result) => ports.openFinalOutput(config, result)),
            Effect.ignore({ log: 'Warn', message: 'Opening the output' }),
          ),
          ports.scope,
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
  ): Effect.Effect<Run, Rejected | Cancelled> =>
    decodeLaunchConfig(config).pipe(
      Effect.flatMap((decoded) =>
        runValidated(decoded, options).pipe(
          Effect.mapError(() => new Cancelled()),
        ),
      ),
    );
  /** Start a configuration an action built and wait for its run to end. */
  const runAgentRequest = (
    config: AgentConfigInput,
    options?: RunValidatedOptions,
  ): Effect.Effect<void, Rejected | Cancelled | RunFailure> =>
    startAgentRequest(config, options).pipe(
      Effect.flatMap((run) => Effect.asVoid(run.result)),
    );

  const documentsOfRun = (runId: RunId) => {
    const run = runView(runId);
    return run === undefined ? undefined : documentsOf(run);
  };
  const runOutputs = {
    getOutputFiles: (runId: RunId) => documentsOfRun(runId)?.files ?? {},
  };

  const readConfig = Effect.fn('HostRunActions.readConfig')(function* (
    runId: RunId,
  ) {
    const config = yield* ports.readConfig(runId).pipe(
      Effect.mapError(
        (cause) =>
          new RunConfigUnreadable({
            runId,
            message: toErrorMessage(cause),
            cause,
          }),
      ),
    );
    return config ?? undefined;
  });

  /** The saved config of a document task's run. `files` holds on every
   *  settled run, so a request on a run that saved no config, or that is
   *  not a document task's, is refused here, which the surface presents. */
  const workflowConfig = Effect.fn('HostRunActions.workflowConfig')(function* (
    runId: RunId,
  ) {
    const config = yield* readConfig(runId);
    if (!config)
      return yield* new Rejected({
        reason: 'This run saved no setup to act on.',
      });
    if (recipeBlockOf(config) !== DOCUMENT_TASK_BLOCK.key)
      return yield* new Rejected({
        reason: 'This action applies to a document task.',
      });
    return config;
  });

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
    runOutputs,
    sendFollowUp(runId, text) {
      const present = (message: string) => ports.showWarning(message);
      const deliver = session
        .request({ kind: 'followUp.send', runId, text })
        .pipe(
          Effect.flatMap((outcome) => {
            const shown = presentFollowUpResult(outcome);
            return shown.severity === 'none'
              ? Effect.void
              : present(shown.message);
          }),
          Effect.catchCause((cause) => {
            const message = toErrorMessage(Cause.squash(cause));
            return Effect.logWarning(
              `Failed to submit follow-up for stream ${runId}: ${message}`,
            ).pipe(
              Effect.annotateLogs({ data: { runId, error: message } }),
              withLogChannel(CHANNEL),
              Effect.andThen(
                present(`Could not send the follow-up: ${message}`),
              ),
              Effect.ignore({ log: 'Warn' }),
            );
          }),
        );
      // Detached: a recovery resume can run a whole model turn, so no host
      // request waits on the outcome.
      return Effect.forkDetach(deliver).pipe(Effect.asVoid);
    },
    /**
     * Resume a settled run, of either category, on the session that holds
     * it: it continues the run's own rows (a child's, with the parent
     * that owns it). A run that does not take it refuses the request with
     * its reason, a missing agent or plugin included; one whose launch is
     * refused (a model this build does not know) shows the notice the
     * failure carries, in this window. A workflow settles with its whole
     * run, whose output opens then.
     */
    resume: Effect.fn('HostRunActions.resume')(function* (runId) {
      yield* nativeAgentRun(runId, 'resume');
      const run = yield* resumeRun(session, runId).pipe(
        Effect.catchTag('RunFailure', (failure) =>
          launchNoticeOf(failure) === undefined
            ? Effect.fail(new Unavailable({ runId, reason: failure.message }))
            : Effect.as(presentRunFailure(ports.present, failure), null),
        ),
      );
      if (run === null) return;
      const config = yield* readConfig(run.runId);
      if (config === undefined || !isTaskConfig(config)) return;
      const result = yield* run.result.pipe(
        Effect.mapError(
          (failure) =>
            new Unavailable({ runId: run.runId, reason: failure.message }),
        ),
      );
      yield* ports
        .openFinalOutput(config, result)
        .pipe(Effect.ignore({ log: 'Warn' }), withLogChannel(CHANNEL));
    }),
    runAgain: (runId) => nativeAgentRun(runId, 'runAgain'),
    runValidated,
    merge: Effect.fn('HostRunActions.merge')(function* (baseFile, editedFile) {
      // A launch that cannot be built (no catalog, no merge task) says
      // why, beside the merge docs, and logs it.
      const refuse = ({ message }: { readonly message: string }) =>
        Effect.logWarning(message).pipe(
          withLogChannel(CHANNEL),
          Effect.andThen(
            ports.present.emit('requestShowError', {
              message,
              docsPage: 'intelligent-merge',
            }),
          ),
          Effect.as(null),
        );
      const config = yield* documentTaskConfig(
        {
          agent: 'merge',
          model: yield* getHelperModelName(roots),
          inputFiles: [baseFile],
          editedFile,
        },
        roots,
      ).pipe(
        Effect.provideService(AgentCatalog, catalog),
        Effect.catchTags({
          DocumentTaskRefused: refuse,
          AgentCatalogLoadError: refuse,
        }),
      );
      if (config !== null) yield* startAgentRequest(config);
    }),
    workflowDiffRequest: Effect.fn('HostRunActions.workflowDiffRequest')(
      function* (runId) {
        yield* requireAction(runId, 'files');
        yield* workflowConfig(runId);
      },
    ),
    workflowFileOperation: Effect.fn('HostRunActions.workflowFileOperation')(
      function* (runId, operation) {
        // `run.files` is gated and held by the session's request handler.
        const config = yield* workflowConfig(runId);
        const inputFile = config.inputFiles[0] ?? '';
        // A pack names its folder for the input; a clean needs none.
        if (operation === 'pack' && !inputFile)
          return { inputFile, result: { status: 'missingParams' } as const };
        const outcome = yield* session
          .request({
            kind: 'run.files',
            runId,
            files:
              operation === 'pack'
                ? {
                    op: 'copy',
                    to: packDestination({
                      runId,
                      inputFile,
                      agent: config.agent,
                      model: config.model,
                    }),
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
        return {
          inputFile,
          result:
            result.status === 'done'
              ? { status: 'success', outputFolder: result.to }
              : result,
        };
      },
    ),
    runCompileFixer: Effect.fn(function* (runId) {
      if (!view().runs.has(runId)) {
        return yield* new Unavailable({
          runId,
          reason: 'The run is no longer open.',
        });
      }
      const config = yield* readConfig(runId);
      const modelOptions = yield* ports.loadModelOptions();
      const plan = yield* planCompileFixer({
        runId,
        runConfig: config,
        documents: documentsOfRun(runId),
        modelOptions,
        workspaceRoot: roots.workspace,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      if (plan.kind === 'warning') {
        yield* ports.showWarning(plan.message);
      } else if (plan.kind === 'info') {
        yield* ports.showInfo(plan.message);
      } else {
        yield* runAgentRequest(plan.config, {
          helperModel: true,
        });
      }
    }),
    fork: Effect.fn('HostRunActions.fork')(function* (runId, at) {
      const forked = yield* forkRun(session, runId, at);
      // The fork waits for its host: continuing it waits on the user's
      // next message. A refusal is told by the resume itself, a refused
      // launch by the notice it carries, shown here; the fork keeps its
      // Resume.
      yield* resumeRun(session, forked).pipe(
        Effect.tapError((error) =>
          launchNoticeOf(error) === undefined
            ? Effect.void
            : presentRunFailure(ports.present, error),
        ),
        Effect.ignore({ log: 'Warn' }),
      );
      return forked;
    }),
  };
});
