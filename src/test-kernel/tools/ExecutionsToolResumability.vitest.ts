// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearStoreCache } from '@agent/storage';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { aggregateId, type RunId } from '@shared/schemas';
import type { RunLedgerDraft } from '@shared/session/runStateFold';
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
        modelHandlerCompatibilityKey: null,
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

  beforeEach(() => {
    clearStoreCache();
  });

  it('does not label a metadata-free run carrying a snapshot as completed', async () => {
    const runId = 'abc123abc123' as RunId;
    const session = defaultSession();
    publishTestRunStart(session, runId);
    await Effect.runPromise(
      session.ledger.appendBatch(runId, null, [openingSnapshot(runId)]),
    );

    const result = await new ExecutionsTool().call({
      path: `/executions/${runId}`,
    });

    expect(result.status).toBe('executed');
    expect(result.output).toContain('Status: resumable');
    expect(result.output).not.toContain('Status: completed');
  });
});
