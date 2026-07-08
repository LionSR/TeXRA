import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  extensionPresentationEvents,
  type ExtensionPresentationEvent,
  type ExtensionPresentationEventPayloads,
  isExtensionPresentationEvent,
} from '@frontend/events/extensionPresentationEvents';
import { emitExtensionProgressEvent } from '@frontend/events/extensionProgressEvents';
import {
  isProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
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
    if (isProgressBackendInteractionEvent(event)) {
      emitExtensionProgressEvent(
        event,
        payload as ProgressBackendInteractionPayloads[typeof event],
      );
    }
  },
};
