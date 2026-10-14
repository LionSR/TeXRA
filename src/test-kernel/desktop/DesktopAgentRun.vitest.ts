// Test setup imports
import '@test/support/sessionGraphTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Deferred, Effect, Stream } from 'effect';
import { describe, expect, onTestFinished, vi } from 'vitest';

// Local imports
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import { createDesktopAgentRun } from '@desktop/main/desktopAgentRun';
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { generateRunId } from '@utils/core';

// Local file imports
import {
  createStubDesktopAgentRunHost,
  localTestProject,
} from './desktopAgentRunTestHarness.ts';

function completedRunEnd(runId: RunId): SessionEventDraft {
  return {
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome: RUN_OUTCOME.COMPLETED,
    output: emptyRunEndOutput(),
  };
}

describe('desktop agent run completion hook', () => {
  // The desktop onboarding funnel refresh rides this hook: a first
  // successful run must clear the setup card without a restart (#11934).
  // The run.end row commits inside finalizeTerminal, before
  // AgentRunLifecycle writes firstRunDone; the hook must wait for the
  // run's result to settle.
  it.effect('fires after the run result settles, not from run.end', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      const onRunCompleted = vi.fn();
      const host = createStubDesktopAgentRunHost();
      const launched = generateRunId();
      const result = yield* Deferred.make<RunEndResult>();
      const run = yield* createDesktopAgentRun({
        host,
        toolEditPreview: {
          openPath: host.openPath,
          openBuildDisplay: host.openBuildDisplay,
          openDiff: host.openDiff,
          closeDiff: () => Effect.void,
        },
        project: localTestProject(session),
        focused: Stream.empty,
        runtime: testRuntime(),
        showAgentConfigBanner: () => Effect.void,
        onRunCompleted: Effect.sync(onRunCompleted),
      });
      onTestFinished(async () => {
        await testRuntime().runPromise(closeSessionOf(session));
      });

      yield* run.launched({
        runId: launched,
        result: Deferred.await(result),
        view: Stream.empty,
        events: Stream.empty,
        interrupt: Effect.void,
      });
      const completedRun = publishTestRunStart(session, generateRunId());
      publishTestRows(session, [completedRunEnd(completedRun)]);
      yield* session.log.settled;
      expect(onRunCompleted).not.toHaveBeenCalled();

      yield* Deferred.succeed(result, {
        runId: launched,
        outcome: RUN_OUTCOME.COMPLETED,
        output: emptyRunEndOutput(),
      });
      yield* Effect.promise(() =>
        vi.waitFor(() => {
          expect(onRunCompleted).toHaveBeenCalledOnce();
        }),
      );
    }),
  );
});
