import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';

import { withEventErrorHandling } from './errorHandling';

/**
 * UI callbacks for the interaction events that still enter the progress view:
 * tool-edit show/resolve and the two approval-bypass state pushes. Durable
 * run and stream facts are handled by `ProgressFactApplier`.
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

type ProgressInteractionRegistration<
  K extends ProgressBackendInteractionEvent,
> = {
  /** Defaults to 'ProgressInteractionHandler' when omitted. */
  readonly module?: string;
  /** Defaults to `failed to handle ${event}` when omitted. */
  readonly context?: string;
  readonly handle: (
    payload: ProgressBackendInteractionPayloads[K],
  ) => void | Promise<void>;
};

type ProgressInteractionRegistrationMap = {
  [K in ProgressBackendInteractionEvent]?: ProgressInteractionRegistration<K>;
};

/** Host adapter for progress-view interaction callbacks. */
export class ProgressInteractionHandler {
  private readonly registrations: ProgressInteractionRegistrationMap;

  constructor(private readonly uiCallbacks: UICallbacks) {
    this.registrations = this.createRegistrations();
  }

  private createRegistrations(): ProgressInteractionRegistrationMap {
    return {
      showToolEditPermission: {
        module: 'ProgressInteractionHandler',
        context: 'failed to show approval prompt',
        handle: this.uiCallbacks.showToolEditPermission,
      },
      resolveToolEditPermission: {
        module: 'ProgressInteractionHandler',
        context: 'failed to resolve approval prompt',
        handle: (payload) =>
          this.uiCallbacks.resolveToolEditPermission(payload.requestId),
      },
      updateToolEditApprovalBypassState: {
        module: 'ProgressInteractionHandler',
        context: 'failed to update approval bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateToolEditApprovalBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
      updateSuperYoloBypassState: {
        module: 'ProgressInteractionHandler',
        context: 'failed to update super yolo bypass state',
        handle: (payload) =>
          this.uiCallbacks.updateSuperYoloBypassState(
            payload.streamId,
            payload.bypassActive,
          ),
      },
    };
  }

  handleInteractionEvent<K extends ProgressBackendInteractionEvent>(
    event: K,
    payload: ProgressBackendInteractionPayloads[K],
  ): void {
    const registration = this.registrations[event] as
      ProgressInteractionRegistration<K> | undefined;
    if (!registration) return;

    withEventErrorHandling(
      registration.module ?? 'ProgressInteractionHandler',
      registration.context ?? `failed to handle ${event}`,
      () => registration.handle(payload),
    );
  }
}
