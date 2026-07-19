import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  isProgressBackendInteractionEvent,
  type ProgressBackendInteractionPayloads,
} from '@controllers/progressView/backend/events/ProgressInteractionHandler';
import {
  extensionPresentationEvents,
  type ExtensionPresentationEvent,
  type ExtensionPresentationEventPayloads,
  isExtensionPresentationEvent,
} from '@frontend/events/extensionPresentationEvents';
import { emitExtensionInteractionEvent } from '@frontend/events/extensionInteractionEvents';

export const extensionAgentRuntimeHost: AgentRuntimeHost = {
  emit: (event, payload) => {
    if (isExtensionPresentationEvent(event)) {
      extensionPresentationEvents.emit(
        event,
        payload as ExtensionPresentationEventPayloads[ExtensionPresentationEvent],
      );
      return;
    }
    if (isProgressBackendInteractionEvent(event)) {
      emitExtensionInteractionEvent(
        event,
        payload as ProgressBackendInteractionPayloads[typeof event],
      );
    }
  },
};
