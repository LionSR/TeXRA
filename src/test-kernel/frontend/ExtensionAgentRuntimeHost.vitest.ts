import { describe, expect, it } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { ProgressEventBus } from '@eventBus/ProgressEventBus';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { extensionPresentationEvents } from '@frontend/events/extensionPresentationEvents';
import type { StreamTabId } from '@shared/schemas';

describe('extensionAgentRuntimeHost', () => {
  it('routes extension presentation events away from ProgressEventBus', () => {
    const busPayloads: unknown[] = [];
    const presentationPayloads: unknown[] = [];
    const disposeBus = ProgressEventBus.on('requestShowError', (payload) =>
      busPayloads.push(payload),
    );
    const disposePresentation = extensionPresentationEvents.on(
      'requestShowError',
      (payload) => presentationPayloads.push(payload),
    );
    busPayloads.length = 0;
    presentationPayloads.length = 0;

    try {
      extensionAgentRuntimeHost.emit('requestShowError', {
        message: 'The model invocation failed.',
      });

      expect(busPayloads).toEqual([]);
      expect(presentationPayloads).toEqual([
        { message: 'The model invocation failed.' },
      ]);
    } finally {
      disposePresentation();
      disposeBus();
    }
  });

  it('routes run progress events through extension host interactions', () => {
    const busPayloads: unknown[] = [];
    const interactionEvents: unknown[] = [];
    const disposeBus = ProgressEventBus.on('setActiveStream', (payload) =>
      busPayloads.push(payload),
    );
    const disposeInteractions = defaultSession().useHostInteractions({
      handleProgressEvent: (event, payload) => {
        interactionEvents.push({ event, payload });
        return true;
      },
      pending: () => [],
      resolve: () => false,
      cancelForStream: () => {},
    });
    busPayloads.length = 0;

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
      expect(busPayloads).toEqual([]);

      disposeInteractions();
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:after-detach' as StreamTabId,
      });

      expect(interactionEvents).toEqual([
        {
          event: 'setActiveStream',
          payload: { streamId: 'extension:progress' as StreamTabId },
        },
      ]);
      expect(busPayloads).toEqual([]);
    } finally {
      disposeInteractions();
      disposeBus();
    }
  });
});
