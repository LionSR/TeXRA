// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { StreamTabId } from '@shared/schemas';
import {
  cleanupAllApprovals,
  toggleProposalBypass,
  toggleToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  handleProgressViewBashApprovalAction,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import {
  ExternalInquiryTool,
  handleExternalInquiryAction,
} from '@tools/inquiry/ExternalInquiryTool';
import { createRecordingHost } from '../progressTestUtils';

async function waitForRecordedEvent<TEvent extends string>(
  events: Array<{ event: TEvent; payload: unknown }>,
  eventName: TEvent,
): Promise<{ event: TEvent; payload: any }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const event = events.find((entry) => entry.event === eventName);
    if (event) return event;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${eventName}`);
}

describe('human prompt progress events', () => {
  afterEach(() => {
    cleanupAllApprovals();
  });

  it('publishes bash approval events through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const streamId = 'stream:bash-approval' as StreamTabId;

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      const approval = withToolFileInteractionContext(
        {
          streamId,
          runtimeHost: explicit.host,
          tracker: {} as never,
        },
        () => requestBashApproval({ command: 'echo hello' }),
      );

      const show = await waitForRecordedEvent(
        explicit.events,
        'showBashPermission',
      );
      await handleProgressViewBashApprovalAction({
        requestId: show.payload.requestId,
        action: 'approve',
      });

      await expect(approval).resolves.toMatchObject({ accepted: true });

      expect(explicit.events).toEqual([
        { event: 'requestEnsureProgressView', payload: {} },
        { event: 'setActiveStream', payload: { streamId } },
        {
          event: 'showBashPermission',
          payload: {
            requestId: show.payload.requestId,
            command: 'echo hello',
            allowBypass: true,
            streamId,
          },
        },
        {
          event: 'resolveBashPermission',
          payload: { requestId: show.payload.requestId },
        },
      ]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('publishes external inquiry events through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const streamId = 'stream:external-inquiry' as StreamTabId;
    const tool = new ExternalInquiryTool();

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      const result = withToolFileInteractionContext(
        {
          streamId,
          runtimeHost: explicit.host,
          tracker: {} as never,
        },
        () =>
          tool.call({
            question: 'What should the agent check next?',
            context: 'Runtime host boundary test',
            suggestSearch: true,
            attachFiles: ['notes.tex'],
          }),
      );

      const show = await waitForRecordedEvent(
        explicit.events,
        'showExternalInquiry',
      );
      await handleExternalInquiryAction({
        requestId: show.payload.requestId,
        action: 'skip',
        feedback: 'Use local evidence instead.',
      });

      await expect(result).resolves.toMatchObject({
        summary: 'User rejected external inquiry with feedback',
      });

      expect(explicit.events).toEqual([
        { event: 'requestEnsureProgressView', payload: {} },
        { event: 'setActiveStream', payload: { streamId } },
        {
          event: 'showExternalInquiry',
          payload: {
            requestId: show.payload.requestId,
            question: 'What should the agent check next?',
            threadId: undefined,
            context: 'Runtime host boundary test',
            suggestSearch: true,
            attachFiles: ['notes.tex'],
            sessionLinks: undefined,
            allowBypass: false,
            streamId,
          },
        },
        {
          event: 'resolveExternalInquiry',
          payload: { requestId: show.payload.requestId },
        },
      ]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('publishes tool-edit bypass changes through the explicit runtime host', () => {
    const explicit = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const streamId = 'stream:tool-edit-bypass' as StreamTabId;

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      const enabled = toggleToolEditApprovalSessionBypass(
        streamId,
        explicit.host,
      );

      expect(enabled).toBe(true);
      expect(explicit.events).toEqual([
        {
          event: 'updateToolEditApprovalBypassState',
          payload: { streamId, bypassActive: true },
        },
      ]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('publishes proposal bypass changes through the explicit runtime host', () => {
    const explicit = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const streamId = 'stream:proposal-bypass' as StreamTabId;

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      const enabled = toggleProposalBypass(streamId, explicit.host);

      expect(enabled).toBe(true);
      expect(explicit.events).toEqual([
        {
          event: 'updateSuperYoloBypassState',
          payload: { streamId, bypassActive: true },
        },
      ]);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });
});
