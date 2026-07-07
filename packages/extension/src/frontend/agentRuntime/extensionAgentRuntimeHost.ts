import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  extensionPresentationEvents,
  type ExtensionPresentationEvent,
  isExtensionPresentationEvent,
} from '@frontend/events/extensionPresentationEvents';

export const extensionAgentRuntimeHost: AgentRuntimeHost = {
  interactions: defaultSession().interactions,
  emit: (event, payload) => {
    if (isExtensionPresentationEvent(event)) {
      extensionPresentationEvents.emit(
        event,
        payload as ProgressEventPayloads[ExtensionPresentationEvent],
      );
      return;
    }
    defaultSession().interactions.handleProgressEvent(event, payload);
  },
};
