import { describe, expect, it } from 'vitest';

import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { extensionPresentationEvents } from '@frontend/events/extensionPresentationEvents';
import { setExtensionProgressEventSink } from '@frontend/events/extensionProgressEvents';
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

  it('routes run progress events through the extension progress sink', () => {
    const progressEvents: unknown[] = [];
    const disposeProgressSink = setExtensionProgressEventSink(
      (event, payload) => {
        progressEvents.push({ event, payload });
      },
    );

    try {
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:progress' as StreamTabId,
      });

      expect(progressEvents).toEqual([
        {
          event: 'setActiveStream',
          payload: { streamId: 'extension:progress' as StreamTabId },
        },
      ]);

      disposeProgressSink();
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:after-detach' as StreamTabId,
      });

      expect(progressEvents).toEqual([
        {
          event: 'setActiveStream',
          payload: { streamId: 'extension:progress' as StreamTabId },
        },
      ]);
    } finally {
      disposeProgressSink();
    }
  });
});
