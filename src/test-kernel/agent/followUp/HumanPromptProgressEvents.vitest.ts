import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Local imports

// Third-party imports
import { afterEach, beforeEach, describe, expect } from 'vitest';

// Local imports
import { currentSession, defaultSession } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { proposalApprovals } from '@tools/approval';
import { AskUserQuestionTool } from '@tools/userQuestion/UserQuestionTool';
import { requestBashApproval } from '@tools/approval/bashApproval';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import { generateRunId } from '@utils/core';

// Local file imports
import { autoDecideRequests, createRecordingHost } from '../progressTestUtils';

function inToolContext<A, E, R>(
  interactions: ReturnType<typeof createRecordingHost>['interactions'],
  runId: RunId,
  run: () => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => defaultSession().interactions.use(interactions)),
    () =>
      run().pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: { runId, session: defaultSession(), toolPolicy: {} },
          }),
        ),
      ),
    (detach) => Effect.sync(detach),
  );
}

/** A run whose existence fact the request rows below hang off. */
function startedRun(): RunId {
  const runId = generateRunId();
  publishTestRunStart(defaultSession(), runId);
  return runId;
}

describe('human prompt progress events', () => {
  beforeEach(async () => {
    await installPlatform({});
  });

  afterEach(() => {
    defaultSession().approvals.clearAll();
  });

  it.live('opens a bash request on the run and settles on its decision', () =>
    Effect.gen(function* () {
      const explicit = createRecordingHost();
      const runId = startedRun();
      const decided = autoDecideRequests(defaultSession(), () => ({
        action: 'approve',
      }));

      try {
        const approval = yield* inToolContext(
          explicit.interactions,
          runId,
          () =>
            requestBashApproval({
              command: 'echo hello',
              cwd: '/tmp/texra-project',
            }),
        );

        expect(approval).toMatchObject({ action: 'approve' });
        expect(decided.opened.map((request) => request.payload)).toEqual([
          {
            kind: 'bash',
            data: {
              requestId: expect.stringContaining('bash-'),
              command: 'echo hello',
              cwd: '/tmp/texra-project',
              allowBypass: true,
              runId,
            },
          },
        ]);
      } finally {
        decided.detach();
      }
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'opens a user-question request and reports the submitted answers',
    () =>
      Effect.gen(function* () {
        const explicit = createRecordingHost();
        const runId = startedRun();
        const tool = new AskUserQuestionTool();
        const question = 'Which path should the agent take?';
        const decided = autoDecideRequests(defaultSession(), () => ({
          action: 'submit',
          answers: { [question]: 'Run the build' },
        }));

        try {
          const result = yield* inToolContext(
            explicit.interactions,
            runId,
            () =>
              tool.call({
                context: 'Choose the next step.',
                questions: [
                  {
                    question,
                    header: 'Path',
                    options: [
                      { label: 'Inspect logs' },
                      { label: 'Run the build' },
                    ],
                  },
                ],
              }),
          );

          expect(result).toMatchObject({
            summary: 'Answered 1 user question(s).',
          });
          expect(decided.opened.map((request) => request.payload)).toEqual([
            {
              kind: 'userQuestion',
              data: {
                requestId: expect.stringContaining('user-question-'),
                questions: [
                  {
                    question,
                    header: 'Path',
                    options: [
                      { label: 'Inspect logs' },
                      { label: 'Run the build' },
                    ],
                  },
                ],
                context: 'Choose the next step.',
                allowBypass: false,
                runId,
              },
            },
          ]);
        } finally {
          decided.detach();
        }
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

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

  it.live('keeps bash and edit session bypasses independent', () =>
    Effect.gen(function* () {
      const explicit = createRecordingHost();
      const runId = startedRun();
      const decided = autoDecideRequests(defaultSession(), () => ({
        action: 'approve',
      }));

      try {
        currentSession().approvals.toolEdit.bypass.setBypass(runId, true, {
          silent: true,
        });

        const approval = yield* inToolContext(
          explicit.interactions,
          runId,
          () => requestBashApproval({ command: 'echo still asks' }),
        );

        expect(approval).toMatchObject({ action: 'approve' });
        expect(decided.opened.at(-1)?.payload).toMatchObject({
          kind: 'bash',
          data: { command: 'echo still asks' },
        });

        // A bash bypass answers without asking; the edit bypass above is not
        // what silenced it.
        currentSession().approvals.bash.bypass.setBypass(runId, true, {
          silent: true,
        });

        const bypassed = yield* inToolContext(
          explicit.interactions,
          runId,
          () => requestBashApproval({ command: 'echo bypassed' }),
        );

        expect(bypassed).toEqual({ action: 'approve' });
        expect(decided.opened).toHaveLength(1);

        currentSession().approvals.toolEdit.bypass.setBypass(runId, false, {
          silent: true,
        });

        const editApproval = yield* inToolContext(
          explicit.interactions,
          runId,
          () =>
            requestToolEditApproval({
              path: 'draft.tex',
              originalContent: 'old',
              proposedContent: 'new',
              sourceTool: 'test',
            }),
        );

        expect(
          decided.opened.filter(
            (request) => request.payload.kind === 'toolEdit',
          ),
        ).toHaveLength(1);
        expect(editApproval).toMatchObject({
          action: 'apply',
          appliedContent: 'new',
        });
      } finally {
        decided.detach();
      }
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
