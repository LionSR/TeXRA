// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { StreamTabId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { waitForRecordedEvent } from '@test/support/asyncTestUtils';
import {
  proposalApprovals,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { AskUserQuestionTool } from '@tools/userQuestion/UserQuestionTool';
import { requestBashApproval } from '@tools/approval/bashApproval';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let detachHostInteractions = (): void => {};

function installTestPlatform(): Promise<void> {
  return installPlatform({}).then(() => {
    detachHostInteractions();
    detachHostInteractions = defaultSession().useHostInteractions({
      requestToolEditApproval: (request) => {
        const handler = testApprovalHandler;
        if (!handler) {
          throw new Error(
            'No test approval handler. Set `testApprovalHandler` first.',
          );
        }
        return handler(request);
      },
      cancel: () => undefined,
    });
  });
}

async function inToolContext<T>(
  interactions: ReturnType<typeof createRecordingHost>['interactions'],
  streamId: StreamTabId,
  run: () => T,
): Promise<Awaited<T>> {
  const detach = defaultSession().useHostInteractions(interactions);
  try {
    return await withRunContext(
      createRunContext({
        streamId,
        session: defaultSession(),
      }),
      () => withToolFileInteractionContext({ tracker: {} as never }, run),
    );
  } finally {
    detach();
  }
}

describe('human prompt progress events', () => {
  beforeEach(async () => {
    testApprovalHandler = undefined;
    await installTestPlatform();
  });

  afterEach(() => {
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
    detachHostInteractions();
    detachHostInteractions = () => {};
    testApprovalHandler = undefined;
  });

  it('publishes bash approval events through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:bash-approval' as StreamTabId;

    const approval = inToolContext(explicit.interactions, streamId, () =>
      requestBashApproval({
        command: 'echo hello',
        cwd: '/tmp/texra-project',
      }),
    );

    const show = await waitForRecordedEvent(
      explicit.events,
      'showBashPermission',
    );
    expect(
      explicit.decisions.submitBash(show.payload.requestId, {
        action: 'approve',
      }),
    ).toBe(true);

    await expect(approval).resolves.toMatchObject({ action: 'approve' });

    expect(explicit.events).toEqual([
      { event: 'requestEnsureProgressView', payload: {} },
      {
        event: 'setActiveStream',
        payload: {
          streamId,
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
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

    const result = inToolContext(explicit.interactions, streamId, () =>
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
    expect(
      explicit.decisions.submitUserQuestion(show.payload.requestId, {
        action: 'submit',
        answers: {
          'Which path should the agent take?': 'Run the build',
        },
      }),
    ).toBe(true);

    await expect(result).resolves.toMatchObject({
      summary: 'Answered 1 user question(s).',
    });

    expect(explicit.events).toEqual([
      { event: 'requestEnsureProgressView', payload: {} },
      {
        event: 'setActiveStream',
        payload: {
          streamId,
          suppressViewSwitch: true,
          ensureVisible: true,
        },
      },
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

  it.each([
    {
      label: 'tool-edit',
      kind: 'toolEdit',
      setBypass: setToolEditApprovalSessionBypass,
    },
    { label: 'bash', kind: 'bash', setBypass: setBashApprovalSessionBypass },
    {
      label: 'proposal',
      kind: 'superYolo',
      setBypass: (streamId: StreamTabId, enabled: boolean) =>
        proposalApprovals().setBypass(streamId, enabled),
    },
  ])(
    'publishes $label bypass changes through the explicit runtime host',
    ({ kind, setBypass }) => {
      const explicit = createRecordingHost();
      const streamId = `stream:${kind}-bypass` as StreamTabId;
      const detach = defaultSession().useHostInteractions(
        explicit.interactions,
      );

      try {
        setBypass(streamId, true);

        expect(explicit.events).toEqual([
          {
            event: 'setApprovalBypassState',
            payload: { streamId, kind, bypassActive: true },
          },
        ]);
      } finally {
        detach();
      }
    },
  );

  it('keeps bash and edit session bypasses independent', async () => {
    const explicit = createRecordingHost();
    const streamId = 'stream:bypass-independence' as StreamTabId;

    try {
      setToolEditApprovalSessionBypass(streamId, true, {
        silent: true,
      });

      const approval = inToolContext(explicit.interactions, streamId, () =>
        requestBashApproval({ command: 'echo still asks' }),
      );

      const show = await waitForRecordedEvent(
        explicit.events,
        'showBashPermission',
      );
      expect(
        explicit.decisions.submitBash(show.payload.requestId, {
          action: 'approve',
        }),
      ).toBe(true);
      await expect(approval).resolves.toMatchObject({ action: 'approve' });

      expect(show.payload.command).toBe('echo still asks');

      explicit.events.length = 0;
      setBashApprovalSessionBypass(streamId, true, {
        silent: true,
      });

      const bypassed = await inToolContext(
        explicit.interactions,
        streamId,
        () => requestBashApproval({ command: 'echo bypassed' }),
      );

      expect(bypassed).toEqual({ action: 'approve' });
      expect(explicit.events).toEqual([]);

      setToolEditApprovalSessionBypass(streamId, false, {
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
        createRunContext({ streamId }),
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
});
