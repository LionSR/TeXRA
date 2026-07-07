import { describe, expect, it } from 'vitest';

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

  it('keeps run progress events on ProgressEventBus', () => {
    const busPayloads: unknown[] = [];
    const disposeBus = ProgressEventBus.on('setActiveStream', (payload) =>
      busPayloads.push(payload),
    );
    busPayloads.length = 0;

    try {
      extensionAgentRuntimeHost.emit('setActiveStream', {
        streamId: 'extension:progress' as StreamTabId,
      });

      expect(busPayloads).toEqual([
        { streamId: 'extension:progress' as StreamTabId },
      ]);
    } finally {
      disposeBus();
    }
  });
});
