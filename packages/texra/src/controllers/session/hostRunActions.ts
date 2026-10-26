/** Host-neutral relaunch and retry actions shared by extension and desktop. */
import * as path from 'node:path';

import {
  type AgentCatalog,
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
  pathToLocationIn,
  type WorkspaceRoots,
  presentFollowUpResult,
  presentRunFailure,
  type SessionHostInteractions,
} from '@texra-ai/harness';
import { entryTypeIn } from '@texra-ai/harness/node';
import { Cause, Effect, FileSystem, Schema, type Scope } from 'effect';

import {
  type ApiKeyProviderId,
  hasUsableApiKey,
  lookupApiKey,
  type SecretsFailed,
} from '@texra-ai/llm';
import {
  toErrorMessage,
  isTaskConfig,
  recipeBlockOf,
  RunIdSchema,
  runActionRefusal,
  type RunAction,
  type RunId,
} from '@texra-ai/harness/schemas';
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
import { TaskRecordsFailed } from '@texra/controllers/server/protocol';

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
class RunLaunchFailed extends Schema.TaggedError<RunLaunchFailed>()(
  'RunLaunchFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The run's saved setup could not be read: the database would not answer
 *  or refused the committed `run.config` row, or the service holding the
 *  run could not answer for it (`cause`). */
class RunConfigUnreadable extends Schema.TaggedError<RunConfigUnreadable>()(
  'RunConfigUnreadable',
  {
    runId: RunIdSchema,
    message: Schema.String,
    cause: Schema.Union([DatabaseReadFailed, TaskRecordsFailed]),
  },
) {}

/** The launch facts an action adds to a validated request, as the
 *  session's `start` takes them. */
type RunValidatedOptions = Pick<StartInput, 'helperModel' | 'approval'>;

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
    DatabaseReadFailed | TaskRecordsFailed
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
  FileSystem.FileSystem | Secrets | AgentCatalog
> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    // The catalog the merge's task resolves its agent against.
    const catalog = yield* Effect.context<AgentCatalog>();
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
          : Effect.fail(
              new Rejected({ reason: runActionRefusal(run, action) }),
            );
      });
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
      function* (runId: RunId, action: 'resume' | 'runAgain') {
        yield* requireAction(runId, action);
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

    // A settle the session refuses fails with its refusal, which the host
    // arm that took the request presents: a retry left parked must not look
    // like one that went through. Defects go to that same boundary.
    const settleRetry = (
      runId: RunId,
      requestId: string,
      decision:
        | { action: 'retry'; credentials: 'configured' | 'personal' }
        | { action: 'cancel' },
    ): Effect.Effect<void, RequestRefusal> =>
      session
        .request({
          kind: 'request.decide',
          runId,
          requestId,
          decision,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError((error): RequestRefusal =>
            isRequestRefusal(error)
              ? error
              : new Unavailable({
                  runId,
                  reason: 'The retry could not be settled.',
                }),
          ),
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
        locatePath: (target) => {
          // With no folder open every path is outside it.
          const location = roots.workspace
            ? pathToLocationIn(roots.workspace, target)
            : undefined;
          return location?.kind === 'workspace'
            ? location
            : { kind: 'external' as const };
        },
        // Asked only of a path `locatePath` placed in the folder.
        exists: (relativePath) =>
          roots.workspace
            ? Effect.map(
                entryTypeIn(fs, path.join(roots.workspace, relativePath)),
                (type) => type !== undefined,
              )
            : Effect.succeed(false),
      },
    });

    return {
      runOutputs,
      sendFollowUp(runId, text) {
        const present = (message: string) => ports.showWarning(message);
        const deliver = session
          .request({ kind: 'followUp.send', runId, text })
          .pipe(
            Effect.flatMap((outcome) => {
              if (outcome.kind !== 'followUp') return Effect.void;
              const shown = presentFollowUpResult(
                outcome.status === 'sent'
                  ? { status: 'sent' }
                  : { status: 'queued', wake: outcome.wake ?? undefined },
              );
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
      }),
      runAgain: (runId) => nativeAgentRun(runId, 'runAgain'),
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
          yield* requireAction(runId, 'files');
          const config = yield* workflowConfig(runId);
          return config ? { runId } : undefined;
        },
      ),
      workflowFileOperation: Effect.fn('HostRunActions.workflowFileOperation')(
        function* (runId, operation) {
          // `run.files` is gated and held by the session's request handler.
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
