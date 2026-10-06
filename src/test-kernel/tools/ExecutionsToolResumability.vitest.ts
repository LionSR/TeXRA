import { it } from '@effect/vitest';
// Test composition imports

import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { aggregateId, type RunId } from '@shared/schemas';
import type { RunHistoryDraft } from '@shared/session/runStateFold';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';

/** A run its loop opened and parked, before any external activity. */
function openedParked(runId: RunId): RunHistoryDraft {
  return {
    type: 'run.position',
    aggregateId: aggregateId('run', runId),
    payload: { family: 'toolUse', at: 'waiting', turn: 0 },
  };
}

describe('ExecutionsTool metadata-free run summary', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {});

  it.live('does not label a metadata-free opened run as completed', () =>
    Effect.gen(function* () {
      const runId = 'abc123abc123' as RunId;
      const session = testDefaultSession();
      publishTestRunStart(session, runId);
      yield* session.runHistory.appendBatch(runId, null, [openedParked(runId)]);

      const result = yield* ExecutionsTool.call({
        path: `/executions/${runId}`,
      });

      // The fold knows the run from its `run.start` row alone, so the
      // summary reports the phase it actually reached — never a terminal
      // outcome invented from the missing metadata.
      expect(result.status).toBe('executed');
      expect(result.output).toContain('Status: waiting');
      expect(result.output).not.toContain('Status: completed');
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
