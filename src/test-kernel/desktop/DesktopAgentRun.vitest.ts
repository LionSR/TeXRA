// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { describe, expect, onTestFinished, vi } from 'vitest';

// Local imports
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as DesktopAgentLaunch from '@desktop/main/desktopAgentLaunch';
import { createDesktopAgentRun } from '@desktop/main/desktopAgentRun';
import {
  AgentCategory,
  aggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

// Local file imports
import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';

function completedRunEnd(runId: RunId): SessionEventDraft {
  return {
    type: 'run.end',
    aggregateId: aggregateId('run', runId),
    outcome: RUN_OUTCOME.COMPLETED,
    output: emptyRunEndOutput(AgentCategory.ToolUse),
  };
}

describe('desktop agent run completion hook', () => {
  // The desktop onboarding funnel refresh rides this hook: a first
  // successful run must clear the setup card without a restart (#11934).
  // session.onResult fires at run.end inside finalizeTerminal, before
  // AgentRunLifecycle writes firstRunDone; the hook must wait for the
  // awaited launch to settle.
  it.effect('fires after the awaited launch settles, not from run.end', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      const onRunCompleted = vi.fn();
      const host = createStubDesktopAgentRunHost();
      const launchSettled = yield* Deferred.make<void>();
      const launch = vi
        .spyOn(DesktopAgentLaunch, 'launchDesktopAgent')
        .mockReturnValue(Deferred.await(launchSettled));
      onTestFinished(() => {
        launch.mockRestore();
      });
      const run = createDesktopAgentRun({
        host,
        toolEditPreview: {
          openPath: host.openPath,
          openBuildDisplay: host.openBuildDisplay,
          openDiff: host.openDiff,
          closeDiff: () => Effect.void,
        },
        session,
        runtime: testRuntime(),
        showAgentConfigBanner: () => Effect.void,
        onRunCompleted,
      });
      onTestFinished(async () => {
        run.dispose();
        await testRuntime().runPromise(session.dispose());
      });

      const fiber = yield* Effect.forkChild(
        run.runValidated({
          config: ToolUseAgentConfigSchema.parse({
            agent: 'proofreader',
            model: 'deepseekproT',
            agentCategory: AgentCategory.ToolUse,
          }),
        }),
        { startImmediately: true },
      );
      const completedRun = publishTestRunStart(session, generateRunId());
      session.publish([completedRunEnd(completedRun)]);
      yield* session.settlePublications();
      expect(onRunCompleted).not.toHaveBeenCalled();

      yield* Deferred.succeed(launchSettled, undefined);
      yield* Fiber.join(fiber);
      expect(onRunCompleted).toHaveBeenCalledOnce();
    }),
  );
});
