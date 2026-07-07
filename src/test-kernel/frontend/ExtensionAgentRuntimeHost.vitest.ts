import { describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { extensionPresentationEvents } from '@frontend/events/extensionPresentationEvents';
import type { StreamTabId } from '@shared/schemas';

describe('extensionAgentRuntimeHost', () => {
  it('routes extension presentation events to the presentation channel', () => {
    const presentationPayloads: unknown[] = [];
    const disposePresentation = extensionPresentationEvents.on(
      'requestShowError',
      (payload) => presentationPayloads.push(payload),
    );
    presentationPayloads.length = 0;

    try {
      extensionAgentRuntimeHost.emit('requestShowError', {
        message: 'The model invocation failed.',
      });

      expect(presentationPayloads).toEqual([
        { message: 'The model invocation failed.' },
      ]);
    } finally {
      disposePresentation();
    }
  });

  it('routes run progress events through extension host interactions', () => {
    const interactionEvents: unknown[] = [];
    const disposeInteractions = defaultSession().useHostInteractions({
      handleProgressEvent: (event, payload) => {
        interactionEvents.push({ event, payload });
        return true;
      },
      resolve: () => false,
      cancelForStream: () => {},
    });

    try {
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:progress' as StreamTabId,
      });

      expect(interactionEvents).toEqual([
        {
          event: 'setActiveStream',
          payload: { streamId: 'extension:progress' as StreamTabId },
        },
      ]);

      disposeInteractions();
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:after-detach' as StreamTabId,
      });

      // A detached host-interactions implementation no longer receives events.
      expect(interactionEvents).toEqual([
        {
          event: 'setActiveStream',
          payload: { streamId: 'extension:progress' as StreamTabId },
        },
      ]);
    } finally {
      disposeInteractions();
    }
  });
});
