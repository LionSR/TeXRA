// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { currentSession, defaultSession } from '@agent/runtime/SessionHandle';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import type { RunId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { waitForRecordedEvent } from '@test/support/asyncTestUtils';
import { proposalApprovals } from '@tools/approval';
import { AskUserQuestionTool } from '@tools/userQuestion/UserQuestionTool';
import { requestBashApproval } from '@tools/approval/bashApproval';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { generateRunId } from '@utils/core';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let detachHostInteractions = (): void => {};

function installTestPlatform(): Promise<void> {
  return installPlatform({}).then(() => {
    detachHostInteractions();
    detachHostInteractions = defaultSession().interactions.use({
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
  runId: RunId,
  run: () => T,
): Promise<Awaited<T>> {
  const detach = defaultSession().interactions.use(interactions);
  try {
    return await withRunContext(
      createRunContext({
        runId,
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
    const runId = generateRunId();

    const approval = inToolContext(explicit.interactions, runId, () =>
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
        event: 'showBashPermission',
        payload: {
          requestId: show.payload.requestId,
          command: 'echo hello',
          cwd: '/tmp/texra-project',
          allowBypass: true,
          runId,
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
    const runId = generateRunId();
    const tool = new AskUserQuestionTool();

    const result = inToolContext(explicit.interactions, runId, () =>
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
          runId,
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
      setBypass: (runId: RunId, enabled: boolean) =>
        currentSession().approvals.toolEdit.bypass.setBypass(runId, enabled),
    },
    {
      label: 'bash',
      kind: 'bash',
      setBypass: (runId: RunId, enabled: boolean) =>
        currentSession().approvals.bash.bypass.setBypass(runId, enabled),
    },
    {
      label: 'proposal',
      kind: 'superYolo',
      setBypass: (runId: RunId, enabled: boolean) =>
        proposalApprovals().setBypass(runId, enabled),
    },
  ])(
    'publishes $label bypass changes through the explicit runtime host',
    ({ kind, setBypass }) => {
      const explicit = createRecordingHost();
      const runId = generateRunId();
      const detach = defaultSession().interactions.use(explicit.interactions);

      try {
        setBypass(runId, true);

        expect(explicit.events).toEqual([
          {
            event: 'setApprovalBypassState',
            payload: { runId, kind, bypassActive: true },
          },
        ]);
      } finally {
        detach();
      }
    },
  );

  it('keeps bash and edit session bypasses independent', async () => {
    const explicit = createRecordingHost();
    const runId = generateRunId();

    try {
      currentSession().approvals.toolEdit.bypass.setBypass(runId, true, {
        silent: true,
      });

      const approval = inToolContext(explicit.interactions, runId, () =>
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
      currentSession().approvals.bash.bypass.setBypass(runId, true, {
        silent: true,
      });

      const bypassed = await inToolContext(explicit.interactions, runId, () =>
        requestBashApproval({ command: 'echo bypassed' }),
      );

      expect(bypassed).toEqual({ action: 'approve' });
      expect(explicit.events).toEqual([]);

      currentSession().approvals.toolEdit.bypass.setBypass(runId, false, {
        silent: true,
      });

      let editApprovalRequests = 0;
      testApprovalHandler = async (request) => {
        editApprovalRequests += 1;
        return {
          action: 'apply',
          appliedContent: request.proposedContent,
        };
      };

      const editApproval = await withRunContext(
        createRunContext({ runId }),
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
        action: 'apply',
        appliedContent: 'new',
      });
    } finally {
      testApprovalHandler = undefined;
    }
  });
});
