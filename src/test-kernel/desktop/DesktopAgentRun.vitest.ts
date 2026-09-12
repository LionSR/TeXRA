// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import { createDesktopAgentRun } from '@desktop/main/desktopAgentRun';
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

function runEnd(runId: RunId, outcome: RunOutcomeValue): SessionEventDraft {
  return {
    type: 'run.end',
    aggregateId: aggregateId('run', runId),
    outcome,
    output: emptyRunEndOutput(AgentCategory.ToolUse),
    ...(outcome === RUN_OUTCOME.FAILED && {
      error: { kind: 'unexpected' as const, message: 'boom' },
    }),
  };
}

type RunOutcomeValue = (typeof RUN_OUTCOME)[keyof typeof RUN_OUTCOME];

describe('desktop agent run completion hook', () => {
  // The desktop onboarding funnel refresh rides this hook: a first
  // successful run must clear the setup card without a restart (#11934).
  it('reports only a completed terminal result', async () => {
    const session = createTestSession();
    const onRunCompleted = vi.fn();
    const host = createStubDesktopAgentRunHost();
    const run = createDesktopAgentRun({
      host,
      toolEditPreview: host,
      session,
      showAgentConfigBanner: () => undefined,
      onRunCompleted,
    });
    onTestFinished(() => {
      run.dispose();
      session.dispose();
    });

    const failedRun = publishTestRunStart(session, generateRunId());
    session.publish([runEnd(failedRun, RUN_OUTCOME.FAILED)]);
    await session.settlePublications();
    expect(onRunCompleted).not.toHaveBeenCalled();

    const completedRun = publishTestRunStart(session, generateRunId());
    session.publish([runEnd(completedRun, RUN_OUTCOME.COMPLETED)]);
    await session.settlePublications();
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });
});
