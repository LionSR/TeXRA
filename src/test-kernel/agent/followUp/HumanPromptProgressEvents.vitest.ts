// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { waitForRecordedEvent } from '@test/support/asyncTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
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
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { createRecordingHost } from '../progressTestUtils';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;

function installTestPlatform(): Promise<void> {
  return installPlatform(
    {},
    {
      toolEditApproval: (request) => {
        const handler = testApprovalHandler;
        if (!handler) {
          throw new Error(
            'No test approval handler. Set `testApprovalHandler` first.',
          );
        }
        return handler(request);
      },
    },
  );
}

function inToolContext<T>(
  host: AgentRuntimeHost,
  streamId: StreamTabId,
  run: () => T,
): T | Promise<T> {
  return withRunContext(createRunContext({ runtimeHost: host, streamId }), () =>
    withToolFileInteractionContext({ tracker: {} as never }, run),
  );
}

describe('human prompt progress events', () => {
  beforeEach(async () => {
    testApprovalHandler = undefined;
    await installTestPlatform();
  });

  afterEach(() => {
    cleanupAllApprovals();
    testApprovalHandler = undefined;
  });

  it('publishes bash approval events through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:bash-approval' as StreamTabId;

    const approval = inToolContext(explicit.host, streamId, () =>
      requestBashApproval({
        command: 'echo hello',
        cwd: '/tmp/texra-project',
      }),
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

    const result = inToolContext(explicit.host, streamId, () =>
      tool.call({
        context: 'Choose the next step.',
        questions: [
          {
            question: 'Which path should the agent take?',
            header: 'Path',
            options: [{ label: 'Inspect logs' }, { label: 'Run the build' }],
          },
        ],
      }),
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

      const approval = inToolContext(explicit.host, streamId, () =>
        requestBashApproval({ command: 'echo still asks' }),
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

      const bypassed = await inToolContext(explicit.host, streamId, () =>
        requestBashApproval({ command: 'echo bypassed' }),
      );

      expect(bypassed).toEqual({ accepted: true });
      expect(explicit.events).toEqual([]);

      setToolEditApprovalSessionBypass(streamId, false, explicit.host, {
        silent: true,
      });

      let editApprovalRequests = 0;
      testApprovalHandler = async (request) => {
        editApprovalRequests += 1;
        return {
          accepted: true,
          appliedContent: request.proposedContent,
        };
      };

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
      testApprovalHandler = undefined;
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
