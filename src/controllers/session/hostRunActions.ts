/**
 * The host request arms that relaunch or retry a run (PRD
 * one-fold-three-renderers, 8.3): `resume`, `runNew`, `runCompileFixer`,
 * `useOwnApiKey`, and the launcher restore of a settled run's setup. The
 * decision of what to run is host-neutral; a host binds its launcher, its
 * catalog lookups, its key prompt, and its notifications, and both the VS
 * Code extension and the desktop answer the same arms through one body.
 */
import { Effect, SubscriptionRef } from 'effect';

import { presentFollowUpResult, submitFollowUp } from '@agent/followUp';
import { getRunRecords } from '@agent/storage';
import { resolveAgentKey } from '@agent/index/agentRegistry';
import type { RunRequest } from '@agent/core/state/runRequests';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import type { ApiProvider } from '@model/apiProviders';
import {
  API_PROVIDERS,
  lookupApiKeyUncached,
  hasUsableApiKey,
  isApiProvider,
} from '@model/apiProviders';
import { getRuntimeModelDirectFallback } from '@model/runtimeModelRegistry';
import type { AppState } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { Secrets } from '@platform/secrets';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  ExhaustionReasonSchema,
  isPlainAgentIdentity,
  type RunId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { ProgressApiKeyRetryController } from '../progressView/ProgressApiKeyRetryController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpModelOption,
  type ProgressFollowUpState,
} from '../progressView/ProgressFollowUpController';

const log = createLog('HostRunActions');

export interface HostRunActionPorts {
  readonly session: SessionHandle;
  /** Launch or resume a run; the host's own launcher reaches `runAgent`. */
  runAgentRequest(
    request: RunRequest,
    options?: {
      preferHelperModel?: boolean;
      copilotRouteOverride?: 'direct';
      onRun?: () => void;
    },
  ): Promise<void>;
  loadModelOptions(): Promise<readonly ProgressFollowUpModelOption[]>;
  /** Ask the user for a provider key; the controller re-reads the store. */
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  showInfo(message: string): Promise<void> | void;
  showWarning(message: string): Promise<void> | void;
}

interface HostRunActions {
  resume(runId: RunId): Effect.Effect<void, Error>;
  runNew(runId: RunId): Effect.Effect<void, Error>;
  runCompileFixer(runId: RunId): Effect.Effect<void, Error>;
  readConfig(runId: RunId): Effect.Effect<AgentConfig | undefined, Error>;
  /** The retry's switch onto the user's own key. The host arm that took the
   *  request runs it where it stands. */
  useOwnApiKey(
    request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
  ): Effect.Effect<void, unknown, AppState>;
  /** The launcher's form of a settled run's saved setup. */
  restoreState(runId: RunId): Effect.Effect<AgentConfig, Error>;
  /** The run's output facts as the view holds them, read by the workflow
   *  controllers. */
  readonly runOutputs: ProgressFollowUpState & {
    getKnownWorkspaceOutputPaths(runId: RunId): Set<string>;
  };
  restoreProposal(proposal: unknown): AgentConfig;
  sendFollowUp(runId: RunId, text: string): Effect.Effect<void>;
}

export const createHostRunActions = (
  ports: HostRunActionPorts,
): Effect.Effect<HostRunActions, never, Secrets> =>
  Effect.gen(function* () {
    const secrets = yield* Secrets;
    const { session } = ports;
    const view = () => SubscriptionRef.getUnsafe(session.view);

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
      return (yield* getRunRecords(session, runId).readConfig()) ?? undefined;
    });

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
        const config = yield* getRunRecords(session, runId).readConfig();
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
      view().approvals.some(
        (approval) =>
          approval.runId === runId &&
          approval.requestId === requestId &&
          approval.payload.kind === 'retry',
      );

    const settleRetry = (
      runId: RunId,
      requestId: string,
      decision:
        | { action: 'retry'; credentials: 'configured' | 'personal' }
        | { action: 'cancel' },
    ): Effect.Effect<boolean> =>
      // A settle that fails for any reason — the request's own error or a
      // defect — reports false, as the Promise edge's rejection handler did.
      // Interruption is not caught: it belongs to the caller's fiber.
      session.requests
        .request({
          kind: 'decision.retry',
          runId,
          approvalId: requestId,
          decision,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
          Effect.catchDefect(() => Effect.succeed(false)),
        );

    const apiKeyRetry = new ProgressApiKeyRetryController({
      providers: API_PROVIDERS,
      readKey: (provider) => lookupApiKeyUncached(secrets, provider),
      hasUsableKey: (provider) => hasUsableApiKey(secrets, provider),
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
      workspace: WorkspaceFS,
    });

    /** The wire carries the reason as text; an unknown one is no reason. */
    const exhaustionReasonOf = (
      request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
    ) => {
      const parsed = ExhaustionReasonSchema.safeParse(request.exhaustionReason);
      return parsed.success ? parsed.data : undefined;
    };

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
          yield* hostPort(() =>
            ports.showInfo(
              `TeXRA did not record which Copilot model this retry used. ${chooseAnotherModel}`,
            ),
          );
          return;
        }
        const exhaustionReason = exhaustionReasonOf(request);
        let fallback = getRuntimeModelDirectFallback(
          request.model,
          getUseOpenRouter(),
        );
        if (!fallback) {
          yield* hostPort(() =>
            ports.showInfo(
              `No model you can use with your own API key matches this Copilot model. ${chooseAnotherModel}`,
            ),
          );
          return;
        }
        // Key entry can outlive the retry panel, and the user can change the
        // OpenRouter preference while that prompt is open. Revalidate both the
        // exact retry identity and the effective credential owner after each
        // prompt so an old action cannot launch or alter a replacement request.
        let prepared = yield* apiKeyRetry.ensureOwnApiKey({
          provider: fallback.provider,
          exhaustionReason,
        });
        if (!prepared || !isRetryPending(runId, requestId)) return;
        const currentFallback = getRuntimeModelDirectFallback(
          request.model,
          getUseOpenRouter(),
        );
        if (!currentFallback) {
          yield* hostPort(() => ports.showInfo(modelsChanged));
          return;
        }
        if (currentFallback.provider !== fallback.provider) {
          fallback = currentFallback;
          prepared = yield* apiKeyRetry.ensureOwnApiKey({
            provider: fallback.provider,
            exhaustionReason,
          });
          if (!prepared || !isRetryPending(runId, requestId)) return;
          const finalFallback = getRuntimeModelDirectFallback(
            request.model,
            getUseOpenRouter(),
          );
          if (!finalFallback || finalFallback.provider !== fallback.provider) {
            yield* hostPort(() => ports.showInfo(modelsChanged));
            return;
          }
        }
        const config = yield* readConfig(runId);
        if (!config) {
          yield* hostPort(() =>
            ports.showInfo(
              `The settings for this run are no longer available. ${chooseAnotherModel}`,
            ),
          );
          return;
        }
        const model = fallback.model;
        const started = yield* apiKeyRetry.runCopilotFallbackWithRouting(
          {
            stream: runId,
            requestId,
            provider: fallback.provider,
            model,
            exhaustionReason,
            chatGptSubscriptionEligible: fallback.chatGptSubscriptionEligible,
          },
          (copilotRouteOverride) =>
            Effect.suspend(() => {
              if (!isRetryPending(runId, requestId)) {
                return Effect.succeed(false);
              }
              // Start acknowledges ownership of the replacement run. Settlement
              // without an onRun callback means no replacement was launched.
              return hostPort(
                () =>
                  new Promise<boolean>((resolve, reject) => {
                    void ports
                      .runAgentRequest(
                        { config: { ...config, model } },
                        { copilotRouteOverride, onRun: () => resolve(true) },
                      )
                      .then(() => resolve(false), reject);
                  }),
              );
            }),
        );
        if (!started) return;
        yield* settleRetry(runId, requestId, { action: 'cancel' });
      },
    );

    return {
      runOutputs,
      restoreProposal(proposal) {
        const parsed = AgentConfigSchema.safeParse(proposal);
        if (!parsed.success) {
          log.warn('Invalid proposal config', {
            data: parsed.error.issues,
          });
          throw new Rejected({
            reason: 'This proposal does not carry a restorable setup.',
          });
        }
        return parsed.data;
      },
      sendFollowUp(runId, text) {
        const present = (message: string) =>
          Effect.tryPromise({
            try: async () => {
              await ports.showWarning(message);
            },
            catch: ensureError,
          });
        const deliver = Effect.gen(function* () {
          const result = yield* submitFollowUp(
            runId,
            { text },
            { session },
          ).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const message = toErrorMessage(error);
                log.warn(
                  `Failed to submit follow-up for stream ${runId}: ${message}`,
                  { data: { runId, error: message } },
                );
                yield* present(`Could not send the follow-up: ${message}`);
                return undefined;
              }),
            ),
          );
          if (!result) return;
          session.publish([
            {
              type: 'updateQueuedFollowUps',
              aggregateId: qualifyAggregateId('run', runId),
              messages: session.followUps.getAll(runId),
            },
          ]);
          const presentation = presentFollowUpResult(result);
          if (presentation.severity !== 'none')
            yield* present(presentation.message);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              log.warn(
                `Follow-up presentation failed for stream ${runId}: ${String(cause)}`,
              );
            }),
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
          yield* Effect.tryPromise({
            try: () => platform().agentResume.tryResumeRun(runId),
            catch: ensureError,
          });
          return;
        }
        yield* Effect.tryPromise({
          try: () => ports.runAgentRequest({ config, runId }),
          catch: ensureError,
        });
      }),
      runNew: Effect.fn('HostRunActions.runNew')(function* (runId) {
        const config = yield* nativeAgentRun(runId, 're-run');
        yield* Effect.tryPromise({
          try: () => ports.runAgentRequest({ config }),
          catch: ensureError,
        });
      }),
      readConfig,
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
        const plan = yield* Effect.tryPromise({
          try: () => followUp.planCompileFixerForRun(runId, config),
          catch: ensureError,
        });
        if (plan.kind === 'warning') {
          yield* Effect.tryPromise({
            try: async () => await ports.showWarning(plan.message),
            catch: ensureError,
          });
        } else if (plan.kind === 'info') {
          yield* Effect.tryPromise({
            try: async () => await ports.showInfo(plan.message),
            catch: ensureError,
          });
        } else {
          yield* Effect.tryPromise({
            try: () =>
              ports.runAgentRequest(plan.request, {
                preferHelperModel: true,
              }),
            catch: ensureError,
          });
        }
      }),
      useOwnApiKey(request) {
        if (request.exhaustionReason === 'copilot-subscription') {
          return copilotFallback(request);
        }
        const provider =
          request.provider != null && isApiProvider(request.provider)
            ? request.provider
            : undefined;
        return apiKeyRetry.useOwnApiKey({
          stream: request.runId,
          requestId: request.requestId,
          model: request.model ?? undefined,
          provider,
          exhaustionReason: exhaustionReasonOf(request),
          kimiCodeRoutedOnFailure: request.kimiCodeRoutedOnFailure ?? undefined,
        });
      },
      restoreState: Effect.fn('HostRunActions.restoreState')(function* (runId) {
        return yield* nativeAgentRun(runId, 'restored');
      }),
    };
  });

/** The launcher's form of a run configuration (PRD 8.5, `launch`). */
export function launchPatchOf(config: AgentConfig) {
  const toolConfig = config.toolConfig;
  const agentCategory = config.agentCategory;
  const resolvedAgent = resolveAgentKey(config.agent, agentCategory);
  return LaunchSurfaceSchema.parse({
    sessionType: agentCategory,
    agent: { [agentCategory]: resolvedAgent },
    model: config.model,
    instruction: { [agentCategory]: config.instruction },
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
