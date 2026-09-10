/**
 * The host request arms that relaunch or retry a run (PRD
 * one-fold-three-renderers, 8.3): `resume`, `runNew`, `runCompileFixer`,
 * `useOwnApiKey`, and the launcher restore of a settled run's setup. The
 * decision of what to run is host-neutral; a host binds its launcher, its
 * catalog lookups, its key prompt, and its notifications, and both the VS
 * Code extension and the desktop answer the same arms through one body.
 */
import { Effect, SubscriptionRef } from 'effect';

import { getExecutionRecords } from '@agent/storage';
import { resolveAgentKey } from '@agent/index/agentRegistry';
import type { ExecutionRequest } from '@agent/core/state/executionRequests';
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
import { platform } from '@platform/platform';
import {
  AgentCategory,
  ExhaustionReasonSchema,
  isPlainAgentIdentity,
  type StreamTabId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import { LaunchSurfaceSchema } from '@shared/session/surface';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { ensureError } from '@utils/errors/errorMessage';

import { submitProgressFollowUp } from '../progressView/progressFollowUpSubmit';
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
  runExecutionRequest(
    request: ExecutionRequest,
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
  resume(streamId: StreamTabId): Effect.Effect<void, Error>;
  runNew(streamId: StreamTabId): Effect.Effect<void, Error>;
  runCompileFixer(streamId: StreamTabId): Effect.Effect<void, Error>;
  readConfig(
    streamId: StreamTabId,
  ): Effect.Effect<AgentConfig | undefined, Error>;
  /** The retry's switch onto the user's own key. The host arm that took the
   *  request runs it where it stands. */
  useOwnApiKey(
    request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
  ): Effect.Effect<void, unknown>;
  /** The launcher's form of a settled run's saved setup. */
  restoreState(streamId: StreamTabId): Effect.Effect<AgentConfig, Error>;
  /** The hydrated stream state used by the workflow controllers. */
  readonly snapshotPort: ProgressFollowUpState & {
    getKnownWorkspaceOutputPaths(streamId: StreamTabId): Set<string>;
  };
  restoreProposal(proposal: unknown): AgentConfig;
  sendFollowUp(streamId: StreamTabId, text: string): Effect.Effect<void>;
}

export function createHostRunActions(
  ports: HostRunActionPorts,
): HostRunActions {
  const { session } = ports;
  const { snapshots } = session;
  const view = () => SubscriptionRef.getUnsafe(session.view);

  const getRunMetadata = (streamId: StreamTabId): RunMetadata => {
    const metadata = snapshots.getRunMetadata(streamId);
    return {
      ...metadata,
      executionId:
        metadata.executionId ?? view().streams.get(streamId)?.executionId,
    };
  };

  const snapshotPort = {
    getRunMetadata,
    getOutputFiles: (streamId: StreamTabId) =>
      snapshots.getOutputFiles(streamId),
    getCompileFailures: (streamId: StreamTabId) =>
      snapshots.getCompileFailures(streamId),
    getKnownWorkspaceOutputPaths: (streamId: StreamTabId) =>
      snapshots.getKnownFilePaths(streamId, { workspaceOnly: true }),
  };

  const readConfig = Effect.fn('HostRunActions.readConfig')(function* (
    streamId: StreamTabId,
  ) {
    yield* snapshots.preload([streamId]);
    const { executionId } = getRunMetadata(streamId);
    return executionId
      ? ((yield* getExecutionRecords(session, executionId).readConfig()) ??
          undefined)
      : undefined;
  });

  /** A run the launcher can relaunch: a TeXRA agent with a saved config. */
  const nativeAgentRun = Effect.fn('HostRunActions.nativeAgentRun')(function* (
    streamId: StreamTabId,
    action: string,
  ) {
    if (!view().streams.has(streamId)) {
      return yield* Effect.fail(
        new Unavailable({
          streamId,
          reason: 'The stream is no longer open.',
        }),
      );
    }
    yield* snapshots.preload([streamId]);
    const metadata = getRunMetadata(streamId);
    if (!isPlainAgentIdentity(metadata.identity)) {
      return yield* Effect.fail(
        new Rejected({
          reason: `Only TeXRA agent runs can be ${action} from here; this stream's run is not one.`,
        }),
      );
    }
    const config = metadata.executionId
      ? yield* getExecutionRecords(session, metadata.executionId).readConfig()
      : null;
    if (!config) {
      return yield* Effect.fail(
        new Rejected({
          reason: `This run's configuration was not saved, so it cannot be ${action}.`,
        }),
      );
    }
    return { ...metadata, config };
  });

  const isRetryPending = (streamId: StreamTabId, requestId: string) =>
    view().approvals.some(
      (approval) =>
        approval.streamId === streamId &&
        approval.requestId === requestId &&
        approval.payload.kind === 'retry',
    );

  const settleRetry = (
    streamId: StreamTabId,
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
        streamId,
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
    readKey: (provider) => lookupApiKeyUncached(platform().secrets, provider),
    hasUsableKey: (provider) => hasUsableApiKey(platform().secrets, provider),
    promptForApiKey: (provider) => ports.promptForApiKey(provider),
    isRetryPending,
    triggerRetry: (streamId, requestId) =>
      settleRetry(streamId, requestId, {
        action: 'retry',
        credentials: 'personal',
      }),
  });

  const followUp = new ProgressFollowUpController({
    loadModelOptions: () => ports.loadModelOptions(),
    state: snapshotPort,
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
      const { streamId, requestId } = request;
      if (!isRetryPending(streamId, requestId)) return;
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
      if (!prepared || !isRetryPending(streamId, requestId)) return;
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
        if (!prepared || !isRetryPending(streamId, requestId)) return;
        const finalFallback = getRuntimeModelDirectFallback(
          request.model,
          getUseOpenRouter(),
        );
        if (!finalFallback || finalFallback.provider !== fallback.provider) {
          yield* hostPort(() => ports.showInfo(modelsChanged));
          return;
        }
      }
      const config = yield* readConfig(streamId);
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
          stream: streamId,
          requestId,
          provider: fallback.provider,
          model,
          exhaustionReason,
          chatGptSubscriptionEligible: fallback.chatGptSubscriptionEligible,
        },
        (copilotRouteOverride) =>
          Effect.suspend(() => {
            if (!isRetryPending(streamId, requestId)) {
              return Effect.succeed(false);
            }
            // Start acknowledges ownership of the replacement run. Settlement
            // without an onRun callback means no replacement was launched.
            return hostPort(
              () =>
                new Promise<boolean>((resolve, reject) => {
                  void ports
                    .runExecutionRequest(
                      { config: { ...config, model } },
                      { copilotRouteOverride, onRun: () => resolve(true) },
                    )
                    .then(() => resolve(false), reject);
                }),
            );
          }),
      );
      if (!started) return;
      yield* settleRetry(streamId, requestId, { action: 'cancel' });
    },
  );

  return {
    snapshotPort,
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
    sendFollowUp(streamId, text) {
      return submitProgressFollowUp({
        session,
        streamId,
        input: { text },
        // Programmatic file feedback has no composer to acknowledge.
        acknowledge: () => {},
        showInfo: ports.showWarning,
      }).pipe(Effect.asVoid);
    },
    /**
     * Resume the run behind a stream: a workflow relaunches through the
     * host's launcher with its execution id; a tool-use run carries
     * canonical session state, so it goes through the resume port that
     * restores it instead of starting a fresh run.
     */
    resume: Effect.fn('HostRunActions.resume')(function* (streamId) {
      const { config, executionId } = yield* nativeAgentRun(
        streamId,
        'resumed',
      );
      if (config.agentCategory !== AgentCategory.Workflow) {
        yield* Effect.tryPromise({
          try: () => platform().agentResume.tryResumeStream(streamId),
          catch: ensureError,
        });
        return;
      }
      yield* Effect.tryPromise({
        try: () =>
          ports.runExecutionRequest({
            config,
            ...(executionId && { executionId }),
          }),
        catch: ensureError,
      });
    }),
    runNew: Effect.fn('HostRunActions.runNew')(function* (streamId) {
      const { config } = yield* nativeAgentRun(streamId, 're-run');
      yield* Effect.tryPromise({
        try: () => ports.runExecutionRequest({ config }),
        catch: ensureError,
      });
    }),
    readConfig,
    runCompileFixer: Effect.fn(function* (streamId) {
      if (!view().streams.has(streamId)) {
        return yield* Effect.fail(
          new Unavailable({
            streamId,
            reason: 'The stream is no longer open.',
          }),
        );
      }
      const config = yield* readConfig(streamId);
      const plan = yield* Effect.tryPromise({
        try: () => followUp.planCompileFixerForStream(streamId, config),
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
            ports.runExecutionRequest(plan.request, {
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
        stream: request.streamId,
        requestId: request.requestId,
        model: request.model ?? undefined,
        provider,
        exhaustionReason: exhaustionReasonOf(request),
        kimiCodeRoutedOnFailure: request.kimiCodeRoutedOnFailure ?? undefined,
      });
    },
    restoreState: Effect.fn('HostRunActions.restoreState')(
      function* (streamId) {
        const { config } = yield* nativeAgentRun(streamId, 'restored');
        return config;
      },
    ),
  };
}

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
