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

import { presentFollowUpResult, submitFollowUp } from '@agent/followUp';
import { getRunRecords } from '@agent/storage';
import {
  validateRunRequest,
  type RunRequest,
  type ValidatedRunRequest,
} from '@agent/core/state/runRequests';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { trackTerminalResultPresentation } from '@agent/runtime/terminalResultToast';
import type { MessageHost, NotificationFailed } from '@hosts/uiHosts';
import { withLogChannel } from '@logger/effectLog';
import type { ApiProvider } from '@model/apiProviders';
import { lookupApiKey, hasUsableApiKey } from '@model/apiProviders';
import type { ModelHostFactUnreadable } from '@model/computeModelOptions';
import { getRuntimeModelDirectFallback } from '@model/copilotRouting';
import type { StateReadFailed } from '@platform/interfaces';
import {
  AgentResume,
  type AgentResumeFailed,
  type AppState,
} from '@platform/interfaces';
import { Secrets, type SecretsFailed } from '@platform/secrets';
import {
  AgentCategory,
  agentKey,
  agentName,
  isPlainAgentIdentity,
  type RunId,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  isRequestRefusal,
  Rejected,
  Unavailable,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { unique } from '@utils/core';
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
  outputFiles: string[];
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
 *  or it refused the committed `run.record` row (`cause`). */
class RunConfigUnreadable extends Data.TaggedError('RunConfigUnreadable')<{
  readonly runId: RunId;
  readonly message: string;
  readonly cause: DatabaseReadFailed;
}> {}

export interface HostRunActionPorts {
  readonly session: SessionHandle;
  /**
   * Launch or resume a validated run; the host's own launcher reaches
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
      onRun?: (runId: RunId) => Effect.Effect<void>;
    },
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
    provider: ApiProvider,
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
  resume(
    runId: RunId,
  ): Effect.Effect<
    void,
    AgentResumeFailed | RequestRefusal | RunConfigUnreadable | RunLaunchFailed,
    AgentResume
  >;
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
  /** The workflow toolbar's latexdiff and pack/clean requests, built from the
   *  run's saved config and its outputs as the view holds them. `undefined`
   *  when the run has no config or is not a workflow: the action is a no-op. */
  workflowDiffRequest(
    runId: RunId,
  ): Effect.Effect<WorkflowDiffRequest | undefined, RunConfigUnreadable>;
  workflowFileOperationRequest(
    runId: RunId,
  ): Effect.Effect<
    WorkflowFileOperationRequest | undefined,
    RunConfigUnreadable
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
  /** The launcher's form of a settled run's saved setup. */
  restoreState(
    runId: RunId,
  ): Effect.Effect<AgentConfig, Rejected | RunConfigUnreadable | Unavailable>;
  /** The run's output facts as the view holds them, read by the workflow
   *  controllers. */
  readonly runOutputs: ProgressFollowUpState & {
    getKnownWorkspaceOutputPaths(runId: RunId): Set<string>;
  };
  restoreProposal(proposal: unknown): Effect.Effect<AgentConfig, Rejected>;
  sendFollowUp(
    runId: RunId,
    text: string,
  ): Effect.Effect<void, never, AgentResume>;
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
    const { session } = ports;
    const view = () => SubscriptionRef.getUnsafe(session.view);

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

    const getOutputFiles = (runId: RunId) => {
      const run = session.runView(runId);
      if (run === undefined) return {};
      return run.category === AgentCategory.Workflow ? run.files : run.outputs;
    };
    const runOutputs = {
      getOutputFiles,
      getCompileFailures: (runId: RunId) =>
        session.runView(runId)?.compileFailures ?? {},
      getKnownWorkspaceOutputPaths: (runId: RunId) =>
        new Set(
          Object.values(getOutputFiles(runId)).flatMap((files) =>
            files
              .filter((file) => file.location.kind === 'workspace')
              .map((file) => file.location.absolutePath),
          ),
        ),
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

    /** The saved config of a workflow run, or `undefined` when the toolbar
     *  action does not apply. */
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
        return config.agentCategory === AgentCategory.Workflow
          ? config
          : undefined;
      },
    );

    /** A run the launcher can relaunch: a TeXRA agent with a saved config. */
    const nativeAgentRun = Effect.fn('HostRunActions.nativeAgentRun')(
      function* (runId: RunId, action: string) {
        const run = session.runView(runId);
        if (run === undefined) {
          return yield* Effect.fail(
            new Unavailable({
              runId,
              reason: 'The run is no longer open.',
            }),
          );
        }
        if (!isPlainAgentIdentity(run.identity)) {
          return yield* Effect.fail(
            new Rejected({
              reason: `Only TeXRA agent runs can be ${action} from here; this run is not one.`,
            }),
          );
        }
        const config = yield* readConfig(runId);
        if (!config) {
          return yield* Effect.fail(
            new Rejected({
              reason: `This run's configuration was not saved, so it cannot be ${action}.`,
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
      session.requests
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
            // unless the run's terminal result already did. The tracker
            // opens at start, inside the fiber whose exit disposes it.
            let terminalResult:
              ReturnType<typeof trackTerminalResultPresentation> | undefined;
            const requestFiber = yield* Effect.forkDetach(
              runAgentRequest(
                { config: { ...config, model } },
                {
                  ownApiKeyFallback: true,
                  onRun: (launchedRunId) =>
                    Effect.sync(() => {
                      terminalResult = trackTerminalResultPresentation(
                        session,
                        (event) => event.runId === launchedRunId,
                      );
                      Deferred.doneUnsafe(runStarted, Effect.void);
                    }),
                },
              ).pipe(
                Effect.onExit((exit) => {
                  const tracker = terminalResult;
                  if (tracker === undefined) return Effect.void;
                  return Effect.gen(function* () {
                    if (Exit.isSuccess(exit)) return;
                    if (Cause.hasInterruptsOnly(exit.cause)) return;
                    const message = toErrorMessage(Cause.squash(exit.cause));
                    yield* Effect.logWarning(
                      `Own-key replacement of run ${runId} failed: ${message}`,
                    );
                    yield* tracker.reportUnhandled(() =>
                      ports.showWarning(`Your own-key run failed: ${message}`),
                    ) ?? Effect.void;
                  }).pipe(
                    Effect.ignore({ log: 'Warn' }),
                    withLogChannel(CHANNEL),
                    Effect.ensuring(Effect.sync(tracker.dispose)),
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
      restoreProposal(proposal) {
        const parsed = AgentConfigSchema.safeParse(proposal);
        if (parsed.success) return Effect.succeed(parsed.data);
        return Effect.logWarning('Invalid proposal config', {
          issues: parsed.error.issues,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new Rejected({
                reason: 'This proposal does not carry a restorable setup.',
              }),
            ),
          ),
          withLogChannel(CHANNEL),
        );
      },
      sendFollowUp(runId, text) {
        const present = (message: string) => ports.showWarning(message);
        const deliver = Effect.gen(function* () {
          const result = yield* submitFollowUp(
            runId,
            { text },
            { session },
          ).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const message = toErrorMessage(error);
                yield* Effect.logWarning(
                  `Failed to submit follow-up for stream ${runId}: ${message}`,
                ).pipe(
                  Effect.annotateLogs({ data: { runId, error: message } }),
                  withLogChannel(CHANNEL),
                );
                yield* present(`Could not send the follow-up: ${message}`);
                return undefined;
              }),
            ),
          );
          if (!result) return;
          const presentation = presentFollowUpResult(result);
          if (presentation.severity !== 'none')
            yield* present(presentation.message);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `Follow-up presentation failed for stream ${runId}: ${String(cause)}`,
            ).pipe(withLogChannel(CHANNEL)),
          ),
        );
        // Detached: a recovery resume can run a whole model turn, so no host
        // request waits on the outcome.
        return Effect.forkDetach(deliver).pipe(Effect.asVoid);
      },
      /**
       * Resume a settled run: a workflow relaunches through the
       * host's launcher with its run id; a tool-use run carries
       * canonical session state, so it goes through the resume port that
       * restores it instead of starting a fresh run.
       */
      resume: Effect.fn('HostRunActions.resume')(function* (runId) {
        const config = yield* nativeAgentRun(runId, 'resumed');
        if (config.agentCategory !== AgentCategory.Workflow) {
          yield* (yield* AgentResume).tryResumeRun(runId);
          return;
        }
        yield* runAgentRequest({ config, runId });
      }),
      runNew: Effect.fn('HostRunActions.runNew')(function* (runId) {
        const config = yield* nativeAgentRun(runId, 're-run');
        yield* runAgentRequest({ config });
      }),
      readConfig,
      workflowDiffRequest: Effect.fn('HostRunActions.workflowDiffRequest')(
        function* (runId) {
          const config = yield* workflowConfig(runId);
          return config ? { runId } : undefined;
        },
      ),
      workflowFileOperationRequest: Effect.fn(
        'HostRunActions.workflowFileOperationRequest',
      )(function* (runId) {
        const config = yield* workflowConfig(runId);
        if (!config) return undefined;
        return {
          agent: config.agent,
          model: config.model,
          inputFile: config.inputFiles[0] ?? '',
          outputFiles: unique(
            [
              ...config.outputFiles,
              ...runOutputs.getKnownWorkspaceOutputPaths(runId),
            ].filter(Boolean),
          ),
          runId,
        };
      }),
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
      restoreState: Effect.fn('HostRunActions.restoreState')(function* (runId) {
        return yield* nativeAgentRun(runId, 'restored');
      }),
    };
  });

/** The launcher's form of a run configuration (PRD 8.5, `launch`). */
export function launchPatchOf(config: AgentConfig) {
  const { toolConfig, agentCategory } = config;
  const resolvedAgent = config.agentSource
    ? agentKey(config.agentSource, agentName(config.agent))
    : config.agent;
  return LaunchSurfaceSchema.parse({
    sessionType: agentCategory,
    agent: resolvedAgent,
    model: config.model,
    instruction: config.instruction,
    editedFile: config.editedFile,
    inputFiles: config.inputFiles,
    contextFiles: config.contextFiles,
    mediaFiles: config.mediaFiles,
    outputFiles: config.outputFiles,
    autoExtractFigure: toolConfig.autoExtractFigure,
    autoExtractTikzFigure: toolConfig.autoExtractTikzFigure,
    autoCompileInputPdf: toolConfig.autoCompileInputPdf,
    attachTeXCount: toolConfig.attachTeXCount,
  });
}
