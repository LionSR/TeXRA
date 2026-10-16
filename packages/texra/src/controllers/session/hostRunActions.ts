/** Host-neutral relaunch and retry actions shared by extension and desktop. */
import { Settings } from '@texra-ai/harness';
import { Cause, Data, Effect, FileSystem, type Scope } from 'effect';

import {
  type ApiKeyProviderId,
  hasUsableApiKey,
  lookupApiKey,
  type SecretsFailed,
} from '@texra-ai/llm';
import {
  type AgentCatalogServices,
  AppState,
  DatabaseReadFailed,
  getHelperModelName,
  isRequestRefusal,
  type ModelHostFactUnreadable,
  Rejected,
  type RequestError,
  type RequestRefusal,
  type LocalSession,
  type Run,
  Secrets,
  type Session,
  type StartInput,
  StateReadFailed,
  Unavailable,
  withLogChannel,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { GlobalStateKey } from '@texra-ai/harness/schemas';
import {
  presentRunFailure,
  type SessionHostInteractions,
} from '@texra-ai/harness';
import { FOLLOW_UP_WAKE_FAILED_MESSAGE } from '@agent/followUp/ToolUseFollowUp';
import { getRuntimeModelDirectFallback } from '@model/copilotRouting';
import { isTaskConfig, recipeBlockOf, type RunId } from '@shared/schemas';
import {
  validateRunRequest,
  type RunRequest,
  type ValidatedRunRequest,
} from '@texra/controllers/session/runRequests';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { packDestination } from '@texra/tools/documents/runOutputs';
import type {
  FileOpResult,
  HostRequest,
} from '@texra/shared/session/hostRequest';
import {
  DOCUMENT_TASK_BLOCK,
  documentsOf,
} from '@texra/shared/plugins/documents';
import type { MessageHost, NotificationFailed } from '@texra/hosts/uiHosts';
import { runActionGuard } from '@texra/controllers/session/runActionGuard';
import type { TaskRecordsUnavailable } from '@texra/controllers/server/serviceSession';
import { entryExists } from '@utils/files/fsEntryExists';
import {
  locateInWorkspace,
  workspaceAbsolutePath,
} from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  ApiKeyPromptFailed,
  ProgressApiKeyRetryController,
} from '../progressView/ProgressApiKeyRetryController';
import {
  ProgressFollowUpController,
  type CompileFixerPlanFailed,
  type ProgressFollowUpModelOption,
  type ProgressFollowUpState,
} from '../progressView/ProgressFollowUpController';
import type { RunEndResult, AgentConfig } from '@texra-ai/harness/schemas';

const CHANNEL = 'HostRunActions';

/** The workflow toolbar's latexdiff over a run's outputs, as each host's
 *  diff command takes it. The run id is the whole request: the diff reads
 *  the run's recorded outputs from the session's fold when it starts. */
export interface WorkflowDiffRequest {
  runId: RunId;
}

/** What the workflow toolbar's pack or clean of a run's files did, and the
 *  input file its message names. */
export interface WorkflowFileOperationResult {
  readonly result: FileOpResult;
  readonly inputFile: string;
}

/**
 * The host's launcher could not start the run, or the run it started
 * failed: a bare `Error`, lifted here with that error as `cause`.
 */
class RunLaunchFailed extends Data.TaggedError('RunLaunchFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The run's saved setup could not be read: the database would not answer
 *  or refused the committed `run.config` row, or the service holding the
 *  run could not answer for it (`cause`). */
class RunConfigUnreadable extends Data.TaggedError('RunConfigUnreadable')<{
  readonly runId: RunId;
  readonly message: string;
  readonly cause: DatabaseReadFailed | TaskRecordsUnavailable;
}> {}

/** The launch facts an action adds to a validated request, as the
 *  session's `start` takes them. */
type RunValidatedOptions = Pick<
  StartInput,
  'helperModel' | 'ownKeyFallback' | 'approval'
>;

/** What the run actions read and present beside the window's `Session`:
 *  filled from this process's session where the window holds one
 *  ({@link localRunActionPorts}), from the service where it runs there. */
export interface RunActionRecordPorts {
  /** The window's roots: its workspace and its settings stores. */
  readonly roots: WorkspaceRoots;
  /** The run's saved setup; null when it saved none. */
  readonly readConfig: (
    runId: RunId,
  ) => Effect.Effect<
    AgentConfig | null,
    DatabaseReadFailed | TaskRecordsUnavailable
  >;
  /** Where a failure before a run opens is presented. */
  readonly present: Pick<SessionHostInteractions, 'emit'>;
}

/** The ports of a window whose process holds its session. */
export const localRunActionPorts = (
  session: LocalSession,
): RunActionRecordPorts => ({
  roots: session.roots,
  readConfig: (runId) => session.records(runId).readConfig(),
  present: session,
});

export interface HostRunActionPorts extends RunActionRecordPorts {
  /** Where this window's run actions land: its own session, or the
   *  background service's. Run state is read from its view. */
  readonly session: Session;
  /** The host's scope: what an action does when its run ends lives as long
   *  as the host. */
  readonly scope: Scope.Scope;
  /** The host's follow-up for a run this window started, once admitted:
   *  select it, and retire the missing-agent banner its agent resolved. */
  launched(run: Run): Effect.Effect<void>;
  /** Open a settled run's final output, when its agent names one. */
  openFinalOutput(
    config: AgentConfig,
    result: RunEndResult,
  ): Effect.Effect<void, Error>;
  loadModelOptions(): Effect.Effect<
    readonly ProgressFollowUpModelOption[],
    ModelHostFactUnreadable | StateReadFailed
  >;
  /**
   * Ask the user for a provider key; the controller re-reads the store. A
   * host that could not ask fails with `ApiKeyPromptFailed`; a user who
   * closes the prompt without entering a key is not a failure.
   */
  promptForApiKey(
    provider: ApiKeyProviderId,
  ): Effect.Effect<void, ApiKeyPromptFailed>;
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
   * The window's launcher: start a validated fresh run on its session,
   * answering once it is admitted. A failure before the run opens is
   * presented here, once, and fails with the launch's own error; the
   * launched run is the host's to select, and its final output opens when
   * it ends.
   */
  runValidated(
    request: ValidatedRunRequest,
    options?: RunValidatedOptions,
  ): Effect.Effect<Run, Error>;
  /** Merge `editedFile` into `baseFile`: the merge agent's document task on
   *  the helper model, answering once its run is admitted. */
  merge(
    baseFile: string,
    editedFile: string,
  ): Effect.Effect<void, RequestRefusal | RunLaunchFailed | StateReadFailed>;
  resume(
    runId: RunId,
  ): Effect.Effect<void, RequestRefusal | RunConfigUnreadable>;
  runNew(
    runId: RunId,
  ): Effect.Effect<
    void,
    RequestRefusal | RunConfigUnreadable | RunLaunchFailed
  >;
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
    | RunLaunchFailed
  >;
  readConfig(
    runId: RunId,
  ): Effect.Effect<AgentConfig | undefined, RunConfigUnreadable>;
  /** The toolbar's latexdiff; `undefined` (a no-op) with no workflow config. */
  workflowDiffRequest(
    runId: RunId,
  ): Effect.Effect<
    WorkflowDiffRequest | undefined,
    Rejected | RunConfigUnreadable
  >;
  /** Pack or clean a workflow run's files, from its saved config: the
   *  action check, then the session's `run.files`, which the process that
   *  holds the run does with it held. No workflow config is a no-op. */
  workflowFileOperation(
    runId: RunId,
    operation: 'pack' | 'clean',
  ): Effect.Effect<
    WorkflowFileOperationResult | undefined,
    RequestError | RunConfigUnreadable
  >;
  /** The retry's switch onto the user's own key. The host arm that took the
   *  request runs it where it stands. */
  useOwnApiKey(
    request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
  ): Effect.Effect<
    void,
    | ApiKeyPromptFailed
    | NotificationFailed
    | RequestRefusal
    | RunConfigUnreadable
    | RunLaunchFailed
    | SecretsFailed
    | StateReadFailed,
    AppState
  >;
  /** A new task holding the run's conversation up to `at` (its latest
   *  settled point when null), continued here so it takes a message: the
   *  fork's id. */
  fork(runId: RunId, at: number | null): Effect.Effect<RunId, RequestRefusal>;
  /** The run's output facts as the view holds them, read by the workflow
   *  controllers. */
  readonly runOutputs: ProgressFollowUpState;
  sendFollowUp(runId: RunId, text: string): Effect.Effect<void>;
}

export const createHostRunActions = (
  ports: HostRunActionPorts,
): Effect.Effect<
  HostRunActions,
  never,
  FileSystem.FileSystem | Secrets | AgentCatalogServices
> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    // The catalog the merge's task resolves its agent against.
    const catalog = yield* Effect.context<AgentCatalogServices>();
    // Resolved once here and carried: the planner's workspace probes below
    // read through this filesystem rather than taking one from whatever
    // context each of its callers happens to run on.
    const fs = yield* FileSystem.FileSystem;
    const { roots, session } = ports;
    const view = () => session.view.current();
    const runView = (runId: RunId) => view().runs.get(runId);
    const guard = runActionGuard({ run: runView });
    const launchFailed = (cause: Error): RequestRefusal | RunLaunchFailed =>
      isRequestRefusal(cause)
        ? cause
        : new RunLaunchFailed({ message: toErrorMessage(cause), cause });

    const runValidated: HostRunActions['runValidated'] = (
      { config },
      options,
    ) =>
      session.start({ config, ...options, interactive: true }).pipe(
        // A failure before the run opens has no row to show it.
        Effect.tapError((error) => presentRunFailure(ports.present, error)),
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
    /** Validate a request an action built, then start it: one that does
     *  not validate is refused before anything starts, a refusal the
     *  launcher worded travels as itself, anything else is RunLaunchFailed. */
    const startAgentRequest = (
      request: RunRequest,
      options?: RunValidatedOptions,
    ): Effect.Effect<Run, RequestRefusal | RunLaunchFailed> => {
      const validated = validateRunRequest(request);
      if (!validated.valid) {
        return Effect.logError(validated.message).pipe(
          Effect.annotateLogs({ data: validated.issue }),
          withLogChannel(CHANNEL),
          Effect.andThen(
            Effect.fail(new Rejected({ reason: validated.message })),
          ),
        );
      }
      return runValidated(validated.request, options).pipe(
        Effect.mapError(launchFailed),
      );
    };
    /** Start a request an action built and wait for its run to end. */
    const runAgentRequest = (
      request: RunRequest,
      options?: RunValidatedOptions,
    ): Effect.Effect<void, RequestRefusal | RunLaunchFailed> =>
      startAgentRequest(request, options).pipe(
        Effect.flatMap((run) =>
          run.result.pipe(Effect.asVoid, Effect.mapError(launchFailed)),
        ),
      );

    const documentsOfRun = (runId: RunId) => {
      const run = runView(runId);
      return run === undefined ? undefined : documentsOf(run);
    };
    const runOutputs = {
      getOutputFiles: (runId: RunId) => documentsOfRun(runId)?.files ?? {},
      getCompileFailures: (runId: RunId) =>
        documentsOfRun(runId)?.compileFailures ?? {},
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

    /** The saved config of a document task's run, or `undefined` when the
     *  toolbar action does not apply. */
    const workflowConfig = Effect.fn('HostRunActions.workflowConfig')(
      function* (runId: RunId) {
        const config = yield* readConfig(runId);
        if (!config) {
          // Record the refusal because this toolbar path has no messaging port.
          yield* Effect.logWarning(
            `Workflow action skipped for stream ${runId}: the run has no persisted config.`,
          ).pipe(withLogChannel(CHANNEL));
          return undefined;
        }
        // `files` holds on every settled run: this is what keeps a stale
        // request off a run that is not a document task.
        return recipeBlockOf(config) === DOCUMENT_TASK_BLOCK.key
          ? config
          : undefined;
      },
    );

    /** A run the launcher can relaunch: a TeXRA agent with a saved config. */
    const nativeAgentRun = Effect.fn('HostRunActions.nativeAgentRun')(
      function* (runId: RunId, action: 'resume' | 'runNew') {
        yield* guard.require(runId, action);
        const config = yield* readConfig(runId);
        if (!config) {
          return yield* Effect.fail(
            new Rejected({
              reason: "This run's configuration was not saved.",
            }),
          );
        }
        return config;
      },
    );

    const isRetryPending = (runId: RunId, requestId: string) =>
      view().requests.some(
        (request) =>
          request.runId === runId &&
          request.requestId === requestId &&
          request.payload.kind === 'retry',
      );

    const retryNotSettled =
      (runId: RunId, requestId: string) =>
      (cause: unknown): Effect.Effect<boolean> =>
        Effect.logWarning(
          `Retry request ${requestId} of run ${runId} could not be settled`,
        ).pipe(
          Effect.annotateLogs({ data: cause }),
          withLogChannel(CHANNEL),
          Effect.as(false),
        );

    const settleRetry = (
      runId: RunId,
      requestId: string,
      decision:
        | { action: 'retry'; credentials: 'configured' | 'personal' }
        | { action: 'cancel' },
    ): Effect.Effect<boolean> =>
      // A settle that fails for any reason — the request's own error or a
      // defect — is logged and reports false, as the Promise edge's rejection
      // handler did. Interruption is not caught: it belongs to the caller's
      // fiber.
      session
        .request({
          kind: 'request.decide',
          runId,
          requestId,
          decision,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(retryNotSettled(runId, requestId)),
          Effect.catchDefect(retryNotSettled(runId, requestId)),
        );

    const apiKeyRetry = new ProgressApiKeyRetryController({
      readKey: (provider) => lookupApiKey(secrets, provider),
      hasUsableKey: (provider) => hasUsableApiKey(secrets, provider),
      // A host that could not ask returns the port's `ApiKeyPromptFailed`.
      promptForApiKey: (provider) => ports.promptForApiKey(provider),
      isRetryPending,
      triggerRetry: (runId, requestId) =>
        settleRetry(runId, requestId, {
          action: 'retry',
          credentials: 'personal',
        }),
    });

    const followUp = new ProgressFollowUpController({
      loadModelOptions: () => ports.loadModelOptions(),
      state: runOutputs,
      // The session's own folder, carried as data: the planner resolves and
      // probes its candidates there rather than through the calling
      // context's ambient roots.
      workspace: {
        locatePath: (target) => locateInWorkspace(roots.workspace, target),
        exists: (relativePath) =>
          entryExists(fs, workspaceAbsolutePath(roots.workspace, relativePath)),
      },
    });

    /** The Copilot subscription's fallback: a replacement run on the user's
     *  own key for the model Copilot served, then the pending retry is
     *  cancelled in its favor. */
    const copilotFallback = Effect.fn('HostRunActions.copilotFallback')(
      function* (request: Extract<HostRequest, { kind: 'useOwnApiKey' }>) {
        const { runId, requestId } = request;
        if (!isRetryPending(runId, requestId)) return;
        const chooseAnotherModel =
          'Choose another model and start the agent again.';
        const modelsChanged =
          'The available models changed while TeXRA was preparing the API key. Try again.';
        if (!request.model) {
          yield* ports.showInfo(
            `TeXRA did not record which Copilot model this retry used. ${chooseAnotherModel}`,
          );
          return;
        }
        let fallback = getRuntimeModelDirectFallback(
          request.model,
          yield* Settings.get<boolean>(roots, GlobalStateKey.USE_OPENROUTER),
        );
        if (!fallback) {
          yield* ports.showInfo(
            `No model you can use with your own API key matches this Copilot model. ${chooseAnotherModel}`,
          );
          return;
        }
        // Key entry can outlive the retry panel, and the user can change the
        // OpenRouter preference while that prompt is open. Revalidate both the
        // exact retry identity and the effective credential owner after each
        // prompt so an old action cannot launch or alter a replacement request.
        let prepared = yield* apiKeyRetry.ensureOwnApiKey(
          fallback.provider,
          false,
        );
        if (!prepared || !isRetryPending(runId, requestId)) return;
        const currentFallback = getRuntimeModelDirectFallback(
          request.model,
          yield* Settings.get<boolean>(roots, GlobalStateKey.USE_OPENROUTER),
        );
        if (!currentFallback) {
          yield* ports.showInfo(modelsChanged);
          return;
        }
        if (currentFallback.provider !== fallback.provider) {
          fallback = currentFallback;
          prepared = yield* apiKeyRetry.ensureOwnApiKey(
            fallback.provider,
            false,
          );
          if (!prepared || !isRetryPending(runId, requestId)) return;
          const finalFallback = getRuntimeModelDirectFallback(
            request.model,
            yield* Settings.get<boolean>(roots, GlobalStateKey.USE_OPENROUTER),
          );
          if (!finalFallback || finalFallback.provider !== fallback.provider) {
            yield* ports.showInfo(modelsChanged);
            return;
          }
        }
        const config = yield* readConfig(runId);
        if (!config) {
          yield* ports.showInfo(
            `The settings for this run are no longer available. ${chooseAnotherModel}`,
          );
          return;
        }
        const model = fallback.model;
        // The replacement run carries the user's choice itself: it declines
        // the Copilot route and every subscription route for its own
        // bindings. No standing preference is rewritten, so a concurrent run
        // keeps the routes its own user chose.
        // The replacement is started, and the retry cancelled, once it is
        // admitted; a failure after that is the run's own, presented by
        // its result unless that already showed it.
        const started = yield* Effect.suspend(() => {
          if (!isRetryPending(runId, requestId)) return Effect.succeed(false);
          return startAgentRequest(
            { config: { ...config, model } },
            { ownKeyFallback: true },
          ).pipe(
            Effect.tap((run) =>
              Effect.forkIn(
                run.result.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      `Own-key replacement of run ${runId} failed: ${error.message}`,
                    ).pipe(
                      Effect.andThen(
                        presentRunFailure(
                          ports.present,
                          error,
                          'Your own-key run failed: ',
                        ),
                      ),
                      withLogChannel(CHANNEL),
                    ),
                  ),
                ),
                ports.scope,
              ),
            ),
            Effect.as(true),
          );
        });
        if (!started) return;
        yield* settleRetry(runId, requestId, { action: 'cancel' });
      },
    );

    return {
      runOutputs,
      sendFollowUp(runId, text) {
        const present = (message: string) => ports.showWarning(message);
        const deliver = session
          .request({ kind: 'followUp.send', runId, text })
          .pipe(
            Effect.flatMap((outcome) =>
              outcome.kind === 'followUp' && outcome.wake === 'failed'
                ? present(FOLLOW_UP_WAKE_FAILED_MESSAGE)
                : Effect.void,
            ),
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
       * that owns it). A run that does not take it refuses the request (its
       * reason already told); one that waits for what blocks it is asked
       * for, and its own line says what it waits for. A workflow settles
       * with its whole run, whose output opens then.
       */
      resume: Effect.fn('HostRunActions.resume')(function* (runId) {
        yield* nativeAgentRun(runId, 'resume');
        const run = yield* session.resume(runId, { interactive: true }).pipe(
          Effect.map((resumed): Run | null => resumed),
          Effect.catch((refusal) =>
            refusal._tag === 'ResumeRefused' && refusal.reason === 'blocked'
              ? Effect.succeed(null)
              : Effect.fail(
                  new Unavailable({ runId, reason: refusal.message }),
                ),
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
      }, guard.resuming),
      runNew: Effect.fn('HostRunActions.runNew')(function* (runId) {
        const config = yield* nativeAgentRun(runId, 'runNew');
        yield* runAgentRequest({ config });
      }),
      runValidated,
      merge: Effect.fn('HostRunActions.merge')(
        function* (baseFile, editedFile) {
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
            Effect.provideContext(catalog),
            Effect.catchTags({
              DocumentTaskRefused: refuse,
              AgentCatalogLoadError: refuse,
            }),
          );
          if (config !== null) yield* startAgentRequest({ config });
        },
      ),
      readConfig,
      workflowDiffRequest: Effect.fn('HostRunActions.workflowDiffRequest')(
        function* (runId) {
          yield* guard.idle(runId);
          yield* guard.require(runId, 'files');
          const config = yield* workflowConfig(runId);
          return config ? { runId } : undefined;
        },
      ),
      workflowFileOperation: Effect.fn('HostRunActions.workflowFileOperation')(
        function* (runId, operation) {
          yield* guard.require(runId, 'files');
          yield* guard.idle(runId);
          const config = yield* workflowConfig(runId);
          if (!config) return undefined;
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
              Effect.catchTag('NotOwner', () =>
                Effect.fail(
                  new Rejected({
                    reason: 'This run is running or held elsewhere.',
                  }),
                ),
              ),
            );
          if (outcome.kind !== 'runFiles')
            return yield* Effect.die(
              new Error(`run.files answered ${outcome.kind}`),
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
          return yield* Effect.fail(
            new Unavailable({
              runId,
              reason: 'The run is no longer open.',
            }),
          );
        }
        const config = yield* readConfig(runId);
        const plan = yield* followUp.planCompileFixerForRun(runId, config);
        if (plan.kind === 'warning') {
          yield* ports.showWarning(plan.message);
        } else if (plan.kind === 'info') {
          yield* ports.showInfo(plan.message);
        } else {
          yield* runAgentRequest(plan.request, {
            helperModel: true,
          });
        }
      }),
      useOwnApiKey(request) {
        const offer = request.credentialSwitch;
        if (offer.kind === 'copilot-fallback') return copilotFallback(request);
        return apiKeyRetry.useOwnApiKey({
          stream: request.runId,
          requestId: request.requestId,
          provider: offer.provider,
          requireNewKey: offer.kind === 'new-key',
        });
      },
      fork: Effect.fn('HostRunActions.fork')(function* (runId, at) {
        const outcome = yield* session
          .request({ kind: 'run.fork', runId, at })
          .pipe(
            Effect.mapError((error): RequestRefusal =>
              isRequestRefusal(error)
                ? error
                : new Unavailable({
                    runId,
                    reason: 'The task could not be forked.',
                  }),
            ),
          );
        if (outcome.kind !== 'forked')
          return yield* Effect.die(
            new Error(`run.fork answered ${outcome.kind}`),
          );
        // The fork waits for its host: continuing it parks it on the
        // user's next message. A refusal is told by the resume itself, and
        // the fork keeps its Resume.
        yield* session
          .resume(outcome.runId, { interactive: true })
          .pipe(Effect.ignore({ log: 'Warn' }));
        return outcome.runId;
      }),
    };
  });
