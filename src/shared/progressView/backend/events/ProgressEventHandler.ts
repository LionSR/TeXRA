import type { AgentEvent } from '@agent/trace';
import type { SessionFact } from '@agent/runtime/SessionEventHub';
import type { ProgressEventPayloads } from '@agent/runtime/hostProgressEvents';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import type { StreamTabId } from '@shared/schemas';
import type { WebviewBridge } from '@shared/progressView/backend/WebviewBridge';
import type { WebviewUpdater } from '@shared/progressView/backend/WebviewUpdater';
import type { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';

import {
  ProgressFactApplier,
  PROGRESS_BACKEND_RUN_FACT_EVENT_TYPES,
  type GetProgressStreamControls,
  type ProgressEventSubscription,
  type ProgressStreamControls,
} from './ProgressFactApplier';
import { withEventErrorHandling } from './errorHandling';

export {
  PROGRESS_BACKEND_RUN_FACT_EVENT_TYPES,
  type GetProgressStreamControls,
  type ProgressEventSubscription,
  type ProgressStreamControls,
};

/**
 * UI callbacks for the approval events that still flow on the host progress
 * rail: tool-edit show/resolve (emitted by `src/tools/approval` and the native
 * approval paths) and the bypass-state pushes. All other approval kinds reach
 * the webview through their typed `ApprovalRequestHandler` directly.
 */
export interface UICallbacks {
  showToolEditPermission: (
    payload: RuntimeInteractionEventPayloads['showToolEditPermission'],
  ) => void;
  resolveToolEditPermission: (requestId: string) => void;
  updateToolEditApprovalBypassState: (
    streamId: string,
    bypassActive: boolean,
  ) => void;
  updateSuperYoloBypassState: (streamId: string, bypassActive: boolean) => void;
}

export type ProgressBackendInteractionPayloads = Pick<
  RuntimeInteractionEventPayloads,
  | 'showToolEditPermission'
  | 'resolveToolEditPermission'
  | 'updateToolEditApprovalBypassState'
  | 'updateSuperYoloBypassState'
>;

export type ProgressBackendInteractionEvent =
  keyof ProgressBackendInteractionPayloads;

const PROGRESS_BACKEND_INTERACTION_EVENTS = [
  'showToolEditPermission',
  'resolveToolEditPermission',
  'updateToolEditApprovalBypassState',
  'updateSuperYoloBypassState',
] as const satisfies readonly ProgressBackendInteractionEvent[];

const ProgressBackendInteractionEventSet: ReadonlySet<string> = new Set(
  PROGRESS_BACKEND_INTERACTION_EVENTS,
);

export function isProgressBackendInteractionEvent(
  event: string,
): event is ProgressBackendInteractionEvent {
  return ProgressBackendInteractionEventSet.has(event);
}

export type ProgressBackendEventPayloads = ProgressEventPayloads &
  ProgressBackendInteractionPayloads;

export type ProgressBackendEvent = keyof ProgressBackendEventPayloads;

type ProgressEventRegistration<K extends ProgressBackendEvent> = {
  /** Defaults to 'ProgressEvents' when omitted. */
  readonly module?: string;
  /** Defaults to `failed to handle ${event}` when omitted. */
  readonly context?: string;
  readonly handle: (
    payload: ProgressBackendEventPayloads[K],
  ) => void | Promise<void>;
};

type ProgressEventRegistrationMap = {
  [K in ProgressBackendEvent]?: ProgressEventRegistration<K>;
};

/** Compatibility adapter for legacy host progress events. */
export class ProgressEventHandler {
  readonly factApplier: ProgressFactApplier;
  private readonly eventRegistrations: ProgressEventRegistrationMap;

  constructor(
    state: ProgressViewState,
    webviewUpdater: WebviewUpdater,
    webviewBridge: WebviewBridge,
    private readonly uiCallbacks: UICallbacks,
    hasPendingPermissions: (streamId: string) => boolean,
    getStreamControls?: GetProgressStreamControls,
  ) {
    this.factApplier = new ProgressFactApplier(
      state,
      webviewUpdater,
      webviewBridge,
      hasPendingPermissions,
      getStreamControls,
    );
    this.eventRegistrations = this.createEventRegistrations();
  }

  private createEventRegistrations(): ProgressEventRegistrationMap {
    return {
      setActiveStream: {
        handle: (payload) => this.factApplier.handleSetActiveStream(payload),
      },
      updateStreamStatus: {
        handle: ({ streamId, status, previousStatus, substate }) =>
          this.factApplier.setStreamStatus(
            streamId,
            status,
            previousStatus,
            substate,
          ),
      },
      setTaskState: {
        handle: (data) => this.factApplier.handleSetTaskState(data),
      },
      updateConversationProgress: {
        handle: (data) =>
          this.factApplier.handleUpdateConversationProgress(data),
      },
      updateRoundStage: {
        handle: (data) => this.factApplier.handleUpdateRoundStage(data),
      },
      updateActiveSubagents: {
        handle: (data) =>
          this.factApplier.updateActiveChildren(data.parentStreamId, {
            activeField: 'activeSubagents',
            countField: 'finishedSubagentCount',
            next: data.children,
          }),
      },
      updateActiveProcesses: {
        handle: (data) =>
          this.factApplier.updateActiveChildren(data.parentStreamId, {
            activeField: 'activeProcesses',
            countField: 'finishedProcessCount',
            next: data.processes,
          }),
      },
      updateProcessOutput: {
        handle: (data) => this.factApplier.handleUpdateProcessOutput(data),
      },
      inquiryThreadUpdated: {
        handle: (thread) => this.factApplier.handleInquiryThreadUpdated(thread),
      },
      updateStreamDescription: {
        handle: (payload) =>
          this.factApplier.handleUpdateStreamDescription(payload),
      },
      setParentStream: {
        handle: (payload) => this.factApplier.handleSetParentStream(payload),
      },
      // Output events: workflow tabs hold one run; ignore the storageKey dim.
      addOutputFiles: {
        handle: (payload) => this.factApplier.handleAddOutputFiles(payload),
      },
      updateMissingOutputs: {
        handle: (payload) =>
          this.factApplier.handleUpdateMissingOutputs(payload),
      },
      updateCompileFailures: {
        handle: (payload) =>
          this.factApplier.handleUpdateCompileFailures(payload),
      },
      clearMissingOutputs: {
        handle: (payload) =>
          this.factApplier.handleClearMissingOutputs(payload),
      },
      // Usage events: workflow tabs collapse to a single accumulated value;
      // tool-use tabs keep per-run accumulation (resume produces multiple runs).
      updateStreamUsage: {
        handle: (payload) => this.factApplier.handleUpdateStreamUsage(payload),
      },
      updateTodos: {
        handle: (payload) => this.factApplier.handleUpdateTodos(payload),
      },
      // Plan events are rare and critical for the approval UX, so send them
      // whenever the webview is available rather than only for the active tab.
      updatePlan: {
        handle: (payload) => this.factApplier.handleUpdatePlan(payload),
      },
      updateQueuedFollowUps: {
        handle: (payload) =>
          this.factApplier.handleUpdateQueuedFollowUps(payload),
      },
      showToolEditPermission: {
        module: 'ProgressEventHandler',
        context: 'failed to show approval prompt',
        handle: this.uiCallbacks.showToolEditPermission,
      },
      resolveToolEditPermission: {
        module: 'ProgressEventHandler',
        context: 'failed to resolve approval prompt',
        handle: (payload) =>
          this.uiCallbacks.resolveToolEditPermission(payload.requestId),
      },
      updateToolEditApprovalBypassState: {
        module: 'ProgressEventHandler',
        context: 'failed to update approval bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateToolEditApprovalBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
      updateSuperYoloBypassState: {
        module: 'ProgressEventHandler',
        context: 'failed to update super yolo bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateSuperYoloBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
    };
  }

  createLocalSubscription(): ProgressEventSubscription {
    return this.factApplier.createLocalSubscription();
  }

  handleProgressEvent<K extends ProgressBackendEvent>(
    event: K,
    payload: ProgressBackendEventPayloads[K],
  ): void {
    const registration = this.eventRegistrations[event] as
      ProgressEventRegistration<K> | undefined;
    if (!registration) return;

    withEventErrorHandling(
      registration.module ?? 'ProgressEvents',
      registration.context ?? `failed to handle ${event}`,
      () => registration.handle(payload),
    );
  }

  handleSessionFact(fact: SessionFact): void {
    this.factApplier.handleSessionFact(fact);
  }

  handleRunFact(streamId: StreamTabId, event: AgentEvent): void {
    this.factApplier.handleRunFact(streamId, event);
  }

  markAllRunningTasksAsCancelled(): void {
    this.factApplier.markAllRunningTasksAsCancelled();
  }

  syncStreamContent(
    stream: Parameters<ProgressFactApplier['syncStreamContent']>[0],
    options?: Parameters<ProgressFactApplier['syncStreamContent']>[1],
  ): void {
    this.factApplier.syncStreamContent(stream, options);
  }

  setStreamStatus(
    ...args: Parameters<ProgressFactApplier['setStreamStatus']>
  ): ReturnType<ProgressFactApplier['setStreamStatus']> {
    return this.factApplier.setStreamStatus(...args);
  }

  getAllStreamStates(): ReturnType<ProgressFactApplier['getAllStreamStates']> {
    return this.factApplier.getAllStreamStates();
  }
}
