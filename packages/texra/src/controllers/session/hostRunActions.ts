/** Host-neutral relaunch and retry actions shared by extension and desktop. */
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  SubscriptionRef,
} from 'effect';

import {
  type ApiKeyProviderId,
  hasUsableApiKey,
  lookupApiKey,
  type SecretsFailed,
} from '@texra-ai/llm';
import { FOLLOW_UP_WAKE_FAILED_MESSAGE } from '@agent/followUp/ToolUseFollowUp';
import { getRunRecords } from '@agent/storage';
import {
  validateRunRequest,
  type RunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { presentRunFailure } from '@agent/runtime/terminalResultToast';
import { withLogChannel } from '@logger/effectLog';
import type { ModelHostFactUnreadable } from '@model/computeModelOptions';
import { getRuntimeModelDirectFallback } from '@model/copilotRouting';
import type { AppState, StateReadFailed } from '@platform/interfaces';
import { Secrets } from '@platform/secrets';
import { documentsOf } from '@shared/plugins/documents';
import { isDocumentTaskConfig, type RunId } from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  isRequestRefusal,
  Rejected,
  Unavailable,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import type { MessageHost, NotificationFailed } from '@texra/hosts/uiHosts';
import { runActionGuard } from '@texra/controllers/session/runActionGuard';
import { getUseOpenRouter } from '@utils/config/providerConfig';
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
import type { SessionBackend } from './sessionBackend';

const CHANNEL = 'HostRunActions';

/** The workflow toolbar's latexdiff over a run's outputs, as each host's
 *  diff command takes it. The run id is the whole request: the diff reads
 *  the run's recorded outputs from the session's fold when it starts. */
export interface WorkflowDiffRequest {
  runId: RunId;
}

/** The workflow toolbar's pack and clean over a run's output files. */
export interface WorkflowFileOperationRequest {
  agent: string;
  model: string;
  inputFile: string;
  runId: RunId;
}

/**
 * The host's launcher could not start the run: it fails with a bare `Error`,
 * lifted here with that error as `cause`. {@link HostRunActionPorts.runValidated}
 * settles only with the run itself, so the copilot fallback races it against
 * the launcher's start callback; a launch that faults first reaches the
 * waiter as this failure.
 */
class RunLaunchFailed extends Data.TaggedError('RunLaunchFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The run's saved setup could not be read: the database would not answer,
 *  or it refused the committed `run.config` row (`cause`). */
class RunConfigUnreadable extends Data.TaggedError('RunConfigUnreadable')<{
  readonly runId: RunId;
  readonly message: string;
  readonly cause: DatabaseReadFailed;
}> {}

export interface HostRunActionPorts {
  readonly session: SessionHandle;
  /** Where this window's run actions land: its own session, or the
   *  background service's. Run state is read from its view. */
  readonly backend: SessionBackend;
  /**
   * Launch a validated fresh run; the host's own launcher reaches
   * `runAgent`. The Effect settles with the launched run itself — a caller
   * that wants only the launch acknowledged races it against the `onRun`
   * gate instead of awaiting it. It fails with the launcher's own error; the
   * actions below name that channel once.
   */
  runValidated(
    request: ValidatedRunRequest,
    options?: {
      preferHelperModel?: boolean;
      /** This launch replaces a quota-exhausted retry the user answered
       *  with their own API key. */
      ownApiKeyFallback?: boolean;
      /** An Auto-approve launch: the run starts with delegated work
       *  approved. */
      approveDelegatedWork?: boolean;
      onRun?: (runId: RunId) => Effect.Effect<void>;
    },
  ): Effect.Effect<void, Error>;
  /** Open a resumed workflow's final output, as the launcher does a fresh one's. */
  openWorkflowOutput(result: RunEndResult): Effect.Effect<void, Error>;
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
  /** The host's launcher, as the launcher's Send reaches it. */
  readonly runValidated: HostRunActionPorts['runValidated'];
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
  /** Pack or clean a workflow run's outputs, from its saved config and the
   *  outputs the view holds: the action check, then `perform` with the run
   *  held (claim included). No workflow config is a no-op. */
  workflowFileOperation<E, R>(
    runId: RunId,
    operation: 'pack' | 'clean',
    perform: (
      request: WorkflowFileOperationRequest,
    ) => Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E | Rejected | RunConfigUnreadable, R>;
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
): Effect.Effect<HostRunActions, never, FileSystem.FileSystem | Secrets> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    // Resolved once here and carried: the planner's workspace probes below
    // read through this filesystem rather than taking one from whatever
    // context each of its callers happens to run on.
    const fs = yield* FileSystem.FileSystem;
    const { session, backend } = ports;
    const view = () => SubscriptionRef.getUnsafe(backend.view);
    const runView = (runId: RunId) => view().runs.get(runId);
    const guard = runActionGuard({ runView, runs: session.runs });

    /** Validate a request an action built, then launch it: one that does
     *  not validate is refused before anything starts, a refusal the
     *  launcher worded travels as itself, anything else is RunLaunchFailed. */
    const runAgentRequest = (
      request: RunRequest,
      options?: Parameters<HostRunActionPorts['runValidated']>[1],
    ): Effect.Effect<void, RequestRefusal | RunLaunchFailed> => {
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
      return ports
        .runValidated(validated.request, options)
        .pipe(
          Effect.mapError((cause) =>
            isRequestRefusal(cause)
              ? cause
              : new RunLaunchFailed({ message: toErrorMessage(cause), cause }),
          ),
        );
    };

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
      const config = yield* getRunRecords(session, runId)
        .readConfig()
        .pipe(
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
        return isDocumentTaskConfig(config) ? config : undefined;
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
      backend
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
        locatePath: (target) =>
          locateInWorkspace(session.roots.workspace, target),
        exists: (relativePath) =>
          entryExists(
            fs,
            workspaceAbsolutePath(session.roots.workspace, relativePath),
          ),
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
          yield* getUseOpenRouter(session.roots),
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
          yield* getUseOpenRouter(session.roots),
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
            yield* getUseOpenRouter(session.roots),
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
        const started = yield* Effect.suspend(() => {
          if (!isRetryPending(runId, requestId)) return Effect.succeed(false);
          // Start acknowledges ownership of the replacement run. Settlement
          // without an onRun callback means no replacement was launched. The
          // launch settles only with the run itself, so the answer is the
          // first of the launcher's own start callback (the gate) and the
          // detached launch fiber's settlement — a rejection reaches the
          // waiter as the fiber's failure rather than a lost second resolver.
          return Effect.gen(function* () {
            const runStarted = yield* Deferred.make<void>();
            // A failure after start has no waiter: warn, and present it
            // through the session's presenter, which skips a failure its run's
            // terminal result already showed.
            let launched = false;
            const requestFiber = yield* Effect.forkDetach(
              runAgentRequest(
                { config: { ...config, model } },
                {
                  ownApiKeyFallback: true,
                  onRun: () =>
                    Effect.sync(() => {
                      launched = true;
                      Deferred.doneUnsafe(runStarted, Effect.void);
                    }),
                },
              ).pipe(
                Effect.onExit((exit) => {
                  if (!launched || Exit.isSuccess(exit)) return Effect.void;
                  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
                  const error = Cause.squash(exit.cause);
                  return Effect.logWarning(
                    `Own-key replacement of run ${runId} failed: ${toErrorMessage(error)}`,
                  ).pipe(
                    Effect.andThen(
                      presentRunFailure(
                        session.interactions,
                        error,
                        'Your own-key run failed: ',
                      ),
                    ),
                    withLogChannel(CHANNEL),
                  );
                }),
              ),
            );
            return yield* Effect.raceFirst(
              Deferred.await(runStarted).pipe(Effect.as(true)),
              Fiber.await(requestFiber).pipe(
                Effect.flatMap((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.succeed(false)
                    : Effect.failCause(exit.cause),
                ),
              ),
            );
          });
        });
        if (!started) return;
        yield* settleRetry(runId, requestId, { action: 'cancel' });
      },
    );

    return {
      runOutputs,
      sendFollowUp(runId, text) {
        const present = (message: string) => ports.showWarning(message);
        const deliver = backend
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
       * it: it continues the run's own rows. A run that does not take it
       * refuses the request (its reason already told); a workflow settles
       * with its whole run, whose output opens then.
       */
      resume: Effect.fn('HostRunActions.resume')(function* (runId) {
        yield* nativeAgentRun(runId, 'resume');
        const result = (yield* backend.resume(runId))?.result;
        if (result)
          yield* ports
            .openWorkflowOutput(result)
            .pipe(Effect.ignore({ log: 'Warn' }), withLogChannel(CHANNEL));
      }, guard.resuming),
      runNew: Effect.fn('HostRunActions.runNew')(function* (runId) {
        const config = yield* nativeAgentRun(runId, 'runNew');
        yield* runAgentRequest({ config });
      }),
      runValidated: ports.runValidated,
      readConfig,
      workflowDiffRequest: Effect.fn('HostRunActions.workflowDiffRequest')(
        function* (runId) {
          yield* guard.idle(runId);
          yield* guard.require(runId, 'diff');
          const config = yield* workflowConfig(runId);
          return config ? { runId } : undefined;
        },
      ),
      workflowFileOperation: (runId, operation, perform) =>
        Effect.gen(function* () {
          yield* guard.require(runId, operation);
          yield* guard.hold(runId);
          const config = yield* workflowConfig(runId);
          if (!config) return;
          yield* perform({
            agent: config.agent,
            model: config.model,
            inputFile: config.inputFiles[0] ?? '',
            runId,
          });
        }).pipe(Effect.scoped),
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
            preferHelperModel: true,
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
        const outcome = yield* backend
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
        yield* backend
          .resume(outcome.runId)
          .pipe(Effect.ignore({ log: 'Warn' }));
        return outcome.runId;
      }),
    };
  });
