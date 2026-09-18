// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { Effect } from 'effect';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import { ToolUseAgentConfigSchema } from '@agent/core/definition/AgentConfig';
import * as DesktopAgentLaunch from '@desktop/main/desktopAgentLaunch';
import { createDesktopAgentRun } from '@desktop/main/desktopAgentRun';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  AgentCategory,
  aggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
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
  it('fires after the awaited launch settles, not from run.end', async () => {
    const session = createTestSession();
    const onRunCompleted = vi.fn();
    const host = createStubDesktopAgentRunHost();
    let resolveLaunch!: () => void;
    const launchSettled = new Promise<void>((resolve) => {
      resolveLaunch = resolve;
    });
    const launch = vi
      .spyOn(DesktopAgentLaunch, 'launchDesktopAgent')
      .mockReturnValue(Effect.promise(() => launchSettled));
    onTestFinished(() => {
      launch.mockRestore();
    });
    const run = createDesktopAgentRun({
      host,
      toolEditPreview: {
        openPath: host.openPath,
        openBuildDisplay: host.openBuildDisplay,
        openDiff: host.openDiff,
        closeDiff: async () => undefined,
      },
      session,
      runtime: testRuntime(),
      showAgentConfigBanner: () => undefined,
      onRunCompleted,
    });
    onTestFinished(async () => {
      run.dispose();
      await testRuntime().runPromise(session.dispose());
    });

    const settled = run.runValidated({
      config: ToolUseAgentConfigSchema.parse({
        agent: 'proofreader',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
      }),
    });
    const completedRun = publishTestRunStart(session, generateRunId());
    session.publish([completedRunEnd(completedRun)]);
    await testRuntime().runPromise(session.settlePublications());
    expect(onRunCompleted).not.toHaveBeenCalled();

    resolveLaunch();
    await settled;
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });
});
