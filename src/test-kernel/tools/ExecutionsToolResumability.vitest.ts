import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
// Test composition imports

import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { aggregateId, type RunId } from '@shared/schemas';
import type { RunLedgerDraft } from '@shared/session/runStateFold';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';

/** The opening snapshot a run writes before its first external activity. */
function openingSnapshot(runId: RunId): RunLedgerDraft {
  return {
    type: 'flow.snapshot',
    aggregateId: aggregateId('run', runId),
    payload: {
      family: 'toolUse',
      runtime: {
        phase: 'initial',
        round: 0,
        turn: 0,
        continuationIndex: 0,
        modelId: 'test-model',
        modelCompatibilityKey: null,
        lastError: null,
        pendingRetry: null,
      },
      references: { pendingIntents: [], pendingResponse: null },
      state: { shouldSkipCycle: false, stateSlices: null },
    },
  };
}

describe('ExecutionsTool resumability fallback', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(() => {});

  it.live(
    'does not label a metadata-free run carrying a snapshot as completed',
    () =>
      Effect.gen(function* () {
        const runId = 'abc123abc123' as RunId;
        const session = defaultSession();
        publishTestRunStart(session, runId);
        yield* session.ledger.appendBatch(runId, null, [
          openingSnapshot(runId),
        ]);

        const result = yield* new ExecutionsTool().call({
          path: `/executions/${runId}`,
        });

        expect(result.status).toBe('executed');
        expect(result.output).toContain('Status: resumable');
        expect(result.output).not.toContain('Status: completed');
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );
});
