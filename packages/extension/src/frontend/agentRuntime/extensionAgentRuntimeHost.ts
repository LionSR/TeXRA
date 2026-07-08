import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  extensionPresentationEvents,
  type ExtensionPresentationEvent,
  type ExtensionPresentationEventPayloads,
  isExtensionPresentationEvent,
} from '@frontend/events/extensionPresentationEvents';
import { emitExtensionProgressEvent } from '@frontend/events/extensionProgressEvents';

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
    emitExtensionProgressEvent(event, payload);
  },
};
