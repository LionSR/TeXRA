import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  extensionPresentationEvents,
  type ExtensionPresentationEvent,
  type ExtensionPresentationEventPayloads,
  isExtensionPresentationEvent,
} from '@frontend/events/extensionPresentationEvents';
import { emitExtensionProgressEvent } from '@frontend/events/extensionProgressEvents';
import type {
  ProgressBackendEvent,
  ProgressBackendEventPayloads,
} from '@shared/progressView/backend/events/ProgressEventHandler';

export const extensionAgentRuntimeHost: AgentRuntimeHost = {
  interactions: defaultSession().interactions,
  emit: (event, payload) => {
    if (isExtensionPresentationEvent(event)) {
      extensionPresentationEvents.emit(
        event,
        payload as ExtensionPresentationEventPayloads[ExtensionPresentationEvent],
      );
      return;
    }
    emitExtensionProgressEvent(
      event as ProgressBackendEvent,
      payload as ProgressBackendEventPayloads[ProgressBackendEvent],
    );
  },
};
