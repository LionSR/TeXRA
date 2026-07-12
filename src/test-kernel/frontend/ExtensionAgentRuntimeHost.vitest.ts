// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { setExtensionInteractionEventSink } from '@frontend/events/extensionInteractionEvents';
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

  it('routes backend interaction events through the extension interaction sink', () => {
    const interactionEvents: unknown[] = [];
    const disposeInteractionSink = setExtensionInteractionEventSink(
      (event, payload) => {
        interactionEvents.push({ event, payload });
      },
    );

    try {
      extensionAgentRuntimeHost.emit('updateToolEditApprovalBypassState', {
        streamId: 'extension:progress' as StreamTabId,
        bypassActive: true,
      });

      expect(interactionEvents).toEqual([
        {
          event: 'updateToolEditApprovalBypassState',
          payload: {
            streamId: 'extension:progress' as StreamTabId,
            bypassActive: true,
          },
        },
      ]);

      disposeInteractionSink();
      extensionAgentRuntimeHost.emit('updateToolEditApprovalBypassState', {
        streamId: 'extension:after-detach' as StreamTabId,
        bypassActive: false,
      });

      expect(interactionEvents).toEqual([
        {
          event: 'updateToolEditApprovalBypassState',
          payload: {
            streamId: 'extension:progress' as StreamTabId,
            bypassActive: true,
          },
        },
      ]);
    } finally {
      disposeInteractionSink();
    }
  });
});
