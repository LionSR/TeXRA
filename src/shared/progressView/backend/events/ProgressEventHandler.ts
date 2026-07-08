import type { AgentEvent } from '@agent/trace';
import type { SessionFact } from '@agent/runtime/SessionEventHub';
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

type ProgressEventRegistration<K extends ProgressBackendInteractionEvent> = {
  /** Defaults to 'ProgressEvents' when omitted. */
  readonly module?: string;
  /** Defaults to `failed to handle ${event}` when omitted. */
  readonly context?: string;
  readonly handle: (
    payload: ProgressBackendInteractionPayloads[K],
  ) => void | Promise<void>;
};

type ProgressEventRegistrationMap = {
  [K in ProgressBackendInteractionEvent]?: ProgressEventRegistration<K>;
};

/** Host adapter for progress-view interaction callbacks. */
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

  handleProgressEvent<K extends ProgressBackendInteractionEvent>(
    event: K,
    payload: ProgressBackendInteractionPayloads[K],
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
