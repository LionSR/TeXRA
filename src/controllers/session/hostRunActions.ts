/**
 * The host request arms that relaunch or retry a run (PRD
 * one-fold-three-renderers, 8.3): `resume`, `runNew`, `runCompileFixer`,
 * `useOwnApiKey`, and the launcher restore of a settled run's setup. The
 * decision of what to run is host-neutral; a host binds its launcher, its
 * catalog lookups, its key prompt, and its notifications, and both the VS
 * Code extension and the desktop answer the same arms through one body.
 */
import { SubscriptionRef } from 'effect';

import type { ExecutionRequest } from '@agent/core/state/executionRequests';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ApiProvider } from '@model/apiProviders';
import {
  API_PROVIDERS,
  apiKeySecretName,
  hasUsableApiKey,
  isApiProvider,
} from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { getRuntimeModelDirectFallback } from '@model/runtimeModelRegistry';
import { effectRuntime } from '@platform/processRuntime';
import { platform } from '@platform/platform';
import {
  AgentCategory,
  ExhaustionReasonSchema,
  isPlainAgentIdentity,
  type StreamTabId,
} from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { Rejected, Unavailable } from '@shared/session/requestErrors';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { buildMainViewState } from '../mainView/MainViewStateRestoreController';
import { applyFollowUpPlan } from '../progressView/followUpApply';
import { ProgressApiKeyRetryController } from '../progressView/ProgressApiKeyRetryController';
import {
  ProgressFollowUpController,
  type ProgressFollowUpModelOption,
} from '../progressView/ProgressFollowUpController';

export interface HostRunActionPorts {
  readonly session: SessionHandle;
  /** Launch or resume a run; the host's own launcher reaches `runAgent`. */
  runExecutionRequest(
    request: ExecutionRequest,
    options?: { preferHelperModel?: boolean },
  ): Promise<void>;
  /** Launch and report once the runtime owns a run handle (the Copilot
   *  fallback settles the pending retry only after its replacement run
   *  started). */
  runUntilStarted(
    request: ExecutionRequest,
    options: { copilotRouteOverride?: 'direct' },
  ): Promise<boolean>;
  loadModelOptions(): Promise<readonly ProgressFollowUpModelOption[]>;
  /** Ask the user for a provider key; the controller re-reads the store. */
  promptForApiKey(provider?: ApiProvider): Promise<void>;
  showInfo(message: string): Promise<void> | void;
  showWarning(message: string): Promise<void> | void;
  showError(message: string): Promise<void> | void;
  logError(message: string, error: Error | undefined): void;
}

export interface HostRunActions {
  resume(streamId: StreamTabId): Promise<void>;
  runNew(streamId: StreamTabId): Promise<void>;
  runCompileFixer(streamId: StreamTabId): Promise<void>;
  useOwnApiKey(
    request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
  ): Promise<void>;
  /** The launcher's form of a settled run's saved setup. */
  restoreState(streamId: StreamTabId): Promise<AgentConfig>;
  /** The sidecar-backed run record, the view's execution id filling in. */
  getRunMetadata(streamId: StreamTabId): RunMetadata;
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
    getActiveStream: () => '' as const,
    getRunMetadata,
    getOutputFiles: (streamId: StreamTabId) =>
      snapshots.getOutputFiles(streamId),
    getCompileFailures: (streamId: StreamTabId) =>
      snapshots.getCompileFailures(streamId),
    getKnownWorkspaceOutputPaths: (streamId: StreamTabId) =>
      snapshots.getKnownFilePaths(streamId, { workspaceOnly: true }),
    preload: (streamId: StreamTabId) => snapshots.preload([streamId]),
  };

  /** A run the launcher can relaunch: a TeXRA agent with a saved config. */
  async function nativeAgentRun(
    streamId: StreamTabId,
    action: string,
  ): Promise<RunMetadata & { config: AgentConfig }> {
    if (!view().streams.has(streamId)) {
      throw new Unavailable({
        streamId,
        reason: 'The stream is no longer open.',
      });
    }
    await snapshots.preload([streamId]);
    const metadata = getRunMetadata(streamId);
    if (!isPlainAgentIdentity(metadata.identity)) {
      throw new Rejected({
        reason: `Only TeXRA agent runs can be ${action} from here; this stream's run is not one.`,
      });
    }
    const { config } = metadata;
    if (!config) {
      throw new Rejected({
        reason: `This run's configuration was not saved, so it cannot be ${action}.`,
      });
    }
    return { ...metadata, config };
  }

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
  ) =>
    effectRuntime()
      .runPromise(
        session.requests.request({
          kind: 'decision.retry',
          streamId,
          approvalId: requestId,
          decision,
        }),
      )
      .then(
        () => true,
        () => false,
      );

  const apiKeyRetry = new ProgressApiKeyRetryController({
    providers: API_PROVIDERS,
    readKey: (provider) => platform().secrets.get(apiKeySecretName(provider)),
    hasUsableKey: (provider) => hasUsableApiKey(platform().secrets, provider),
    promptForApiKey: (provider) => ports.promptForApiKey(provider),
    invalidateModelOptionsCache,
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
  async function copilotFallback(
    request: Extract<HostRequest, { kind: 'useOwnApiKey' }>,
  ): Promise<void> {
    const { streamId, requestId } = request;
    if (!isRetryPending(streamId, requestId)) return;
    const chooseAnotherModel =
      'Choose another model and start the agent again.';
    const modelsChanged =
      'The available models changed while TeXRA was preparing the API key. Try again.';
    if (!request.model) {
      await ports.showInfo(
        `TeXRA did not record which Copilot model this retry used. ${chooseAnotherModel}`,
      );
      return;
    }
    const exhaustionReason = exhaustionReasonOf(request);
    let fallback = getRuntimeModelDirectFallback(
      request.model,
      getUseOpenRouter(),
    );
    if (!fallback) {
      await ports.showInfo(
        `No model you can use with your own API key matches this Copilot model. ${chooseAnotherModel}`,
      );
      return;
    }
    // Key entry can outlive the retry panel, and the user can change the
    // OpenRouter preference while that prompt is open. Revalidate both the
    // exact retry identity and the effective credential owner after each
    // prompt so an old action cannot launch or alter a replacement request.
    let prepared = await apiKeyRetry.ensureOwnApiKey({
      provider: fallback.provider,
      exhaustionReason,
    });
    if (!prepared || !isRetryPending(streamId, requestId)) return;
    const currentFallback = getRuntimeModelDirectFallback(
      request.model,
      getUseOpenRouter(),
    );
    if (!currentFallback) {
      await ports.showInfo(modelsChanged);
      return;
    }
    if (currentFallback.provider !== fallback.provider) {
      fallback = currentFallback;
      prepared = await apiKeyRetry.ensureOwnApiKey({
        provider: fallback.provider,
        exhaustionReason,
      });
      if (!prepared || !isRetryPending(streamId, requestId)) return;
      const finalFallback = getRuntimeModelDirectFallback(
        request.model,
        getUseOpenRouter(),
      );
      if (!finalFallback || finalFallback.provider !== fallback.provider) {
        await ports.showInfo(modelsChanged);
        return;
      }
    }
    await snapshots.preload([streamId]);
    const { config } = snapshots.getRunMetadata(streamId);
    if (!config) {
      await ports.showInfo(
        `The settings for this run are no longer available. ${chooseAnotherModel}`,
      );
      return;
    }
    const model = fallback.model;
    const started = await apiKeyRetry.runCopilotFallbackWithRouting(
      {
        stream: streamId,
        requestId,
        provider: fallback.provider,
        model,
        exhaustionReason,
        chatGptSubscriptionEligible: fallback.chatGptSubscriptionEligible,
      },
      async (copilotRouteOverride) => {
        if (!isRetryPending(streamId, requestId)) return false;
        return ports.runUntilStarted(
          { config: { ...config, model } },
          { copilotRouteOverride },
        );
      },
    );
    if (!started) return;
    await settleRetry(streamId, requestId, { action: 'cancel' });
  }

  return {
    getRunMetadata,
    /**
     * Resume the run behind a stream: a workflow relaunches through the
     * host's launcher with its execution id; a tool-use run carries
     * canonical session state, so it goes through the resume port that
     * restores it instead of starting a fresh run.
     */
    async resume(streamId) {
      const { config, executionId } = await nativeAgentRun(streamId, 'resumed');
      if (config.agentCategory !== AgentCategory.Workflow) {
        await platform().agentResume.tryResumeStream(streamId);
        return;
      }
      await ports.runExecutionRequest({
        config,
        ...(executionId && { executionId }),
      });
    },
    async runNew(streamId) {
      const { config } = await nativeAgentRun(streamId, 're-run');
      await ports.runExecutionRequest({ config });
    },
    async runCompileFixer(streamId) {
      if (!view().streams.has(streamId)) {
        throw new Unavailable({
          streamId,
          reason: 'The stream is no longer open.',
        });
      }
      await applyFollowUpPlan(
        await followUp.planCompileFixerForStream(streamId),
        {
          showInfo: ports.showInfo,
          showWarning: ports.showWarning,
          showError: ports.showError,
          logError: ports.logError,
          runCompileFixer: (request) =>
            ports.runExecutionRequest(request, { preferHelperModel: true }),
        },
      );
    },
    async useOwnApiKey(request) {
      if (request.exhaustionReason === 'copilot-subscription') {
        await copilotFallback(request);
        return;
      }
      const provider =
        request.provider != null && isApiProvider(request.provider)
          ? request.provider
          : undefined;
      const result = await apiKeyRetry.useOwnApiKey({
        stream: request.streamId,
        requestId: request.requestId,
        model: request.model ?? undefined,
        provider,
        exhaustionReason: exhaustionReasonOf(request),
        kimiCodeRoutedOnFailure: request.kimiCodeRoutedOnFailure ?? undefined,
      });
      if (result.proceeded && !result.retried) {
        await ports.showInfo(
          'Switched to your own API key. There is no pending retry to resume, so run the agent again when you are ready.',
        );
      }
    },
    async restoreState(streamId) {
      const { config } = await nativeAgentRun(streamId, 'restored');
      return config;
    },
  };
}

/** The launcher's form of a run configuration (PRD 8.5, `launch`). */
export function launchPatchOf(config: AgentConfig) {
  const state = buildMainViewState(config);
  const { openedFiles: _opened, latexdiffsVisible: _diffs, ...launch } = state;
  return launch;
}
