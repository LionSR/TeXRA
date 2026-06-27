// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { StreamTabId } from '@shared/schemas';
import {
  AskUserQuestionTool,
  handleUserQuestionAction,
} from '@tools/userQuestion';
import {
  cleanupAllApprovals,
  proposalApprovalState,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
  toggleBashApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  handleProgressViewBashApprovalAction,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import {
  requestToolEditApproval,
  setToolEditApprovalHandler,
} from '@tools/approval/toolEditApproval';
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
    const streamId = 'stream:bash-approval' as StreamTabId;

    const approval = withRunContext(
      createRunContext({ runtimeHost: explicit.host, streamId }),
      () =>
        withToolFileInteractionContext({ tracker: {} as never }, () =>
          requestBashApproval({
            command: 'echo hello',
            cwd: '/tmp/texra-project',
          }),
        ),
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
          cwd: '/tmp/texra-project',
          allowBypass: true,
          streamId,
        },
      },
      {
        event: 'resolveBashPermission',
        payload: { requestId: show.payload.requestId },
      },
    ]);
  });

  it('publishes user question events through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:user-question' as StreamTabId;
    const tool = new AskUserQuestionTool();

    const result = withRunContext(
      createRunContext({ runtimeHost: explicit.host, streamId }),
      () =>
        withToolFileInteractionContext({ tracker: {} as never }, () =>
          tool.call({
            context: 'Choose the next step.',
            questions: [
              {
                question: 'Which path should the agent take?',
                header: 'Path',
                options: [
                  { label: 'Inspect logs' },
                  { label: 'Run the build' },
                ],
              },
            ],
          }),
        ),
    );

    const show = await waitForRecordedEvent(
      explicit.events,
      'showUserQuestion',
    );
    await handleUserQuestionAction({
      requestId: show.payload.requestId,
      action: 'submit',
      answers: {
        'Which path should the agent take?': 'Run the build',
      },
    });

    await expect(result).resolves.toMatchObject({
      summary: 'Answered 1 user question(s).',
    });

    expect(explicit.events).toEqual([
      { event: 'requestEnsureProgressView', payload: {} },
      { event: 'setActiveStream', payload: { streamId } },
      {
        event: 'showUserQuestion',
        payload: {
          requestId: show.payload.requestId,
          questions: [
            {
              question: 'Which path should the agent take?',
              header: 'Path',
              options: [{ label: 'Inspect logs' }, { label: 'Run the build' }],
            },
          ],
          context: 'Choose the next step.',
          allowBypass: false,
          streamId,
        },
      },
      {
        event: 'resolveUserQuestion',
        payload: { requestId: show.payload.requestId },
      },
    ]);
  });

  it('publishes tool-edit bypass changes through the explicit runtime host', () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:tool-edit-bypass' as StreamTabId;

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
  });

  it('publishes bash bypass changes through the explicit runtime host', () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:bash-bypass' as StreamTabId;

    const enabled = toggleBashApprovalSessionBypass(streamId, explicit.host);

    expect(enabled).toBe(true);
    expect(explicit.events).toEqual([
      {
        event: 'updateBashApprovalBypassState',
        payload: { streamId, bypassActive: true },
      },
    ]);
  });

  it('keeps bash and edit session bypasses independent', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:bypass-independence' as StreamTabId;

    try {
      setToolEditApprovalSessionBypass(streamId, true, explicit.host, {
        silent: true,
      });

      const approval = withRunContext(
        createRunContext({ runtimeHost: explicit.host, streamId }),
        () =>
          withToolFileInteractionContext({ tracker: {} as never }, () =>
            requestBashApproval({ command: 'echo still asks' }),
          ),
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

      expect(show.payload.command).toBe('echo still asks');

      explicit.events.length = 0;
      setBashApprovalSessionBypass(streamId, true, explicit.host, {
        silent: true,
      });

      const bypassed = await withRunContext(
        createRunContext({ runtimeHost: explicit.host, streamId }),
        () =>
          withToolFileInteractionContext({ tracker: {} as never }, () =>
            requestBashApproval({ command: 'echo bypassed' }),
          ),
      );

      expect(bypassed).toEqual({ accepted: true });
      expect(explicit.events).toEqual([]);

      setToolEditApprovalSessionBypass(streamId, false, explicit.host, {
        silent: true,
      });

      let editApprovalRequests = 0;
      setToolEditApprovalHandler(async (request) => {
        editApprovalRequests += 1;
        return {
          accepted: true,
          appliedContent: request.proposedContent,
        };
      });

      const editApproval = await withRunContext(
        createRunContext({ runtimeHost: explicit.host, streamId }),
        () =>
          requestToolEditApproval({
            path: 'draft.tex',
            originalContent: 'old',
            proposedContent: 'new',
            sourceTool: 'test',
          }),
      );

      expect(editApprovalRequests).toBe(1);
      expect(editApproval).toMatchObject({
        accepted: true,
        appliedContent: 'new',
      });
    } finally {
      setToolEditApprovalHandler();
    }
  });

  it('publishes proposal bypass changes through the explicit runtime host', () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:proposal-bypass' as StreamTabId;

    const enabled = proposalApprovalState.toggleBypass(streamId, explicit.host);

    expect(enabled).toBe(true);
    expect(explicit.events).toEqual([
      {
        event: 'updateSuperYoloBypassState',
        payload: { streamId, bypassActive: true },
      },
    ]);
  });
});
