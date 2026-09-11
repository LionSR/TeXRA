import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getRunStore } from '@agent/storage';
import { BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  FLOW_KEY_PREFIX,
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  PersistedFlow,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import type { RunId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace' });

class CompleteNode extends BaseNode<{ count: number }> {
  override async post(shared: { count: number }): Promise<string> {
    shared.count += 1;
    return 'complete';
  }
}

class ContinueOnceNode extends BaseNode<{ count: number; continue: boolean }> {
  override async post(shared: {
    count: number;
    continue: boolean;
  }): Promise<string> {
    shared.count += 1;
    return shared.continue ? 'again' : 'complete';
  }
}

class SuspendNode extends BaseNode<{ count: number }> {
  override async post(shared: { count: number }): Promise<string> {
    shared.count += 1;
    return FlowTransition.WAITING;
  }
}

type RunStore = ReturnType<typeof getRunStore>;

function expectStoredRecord(
  store: RunStore,
  runId: RunId,
  expected: Record<string, unknown>,
): Promise<void> {
  return expect(store.read<FlowRecord>(flowKey(runId))).resolves.toMatchObject(
    expected,
  );
}

describe('PersistedFlow', () => {
  // Regression for the runKvFiles leak fix: consumers that recognize a
  // flow record's KV filename (e.g. `isKVFile`) now import FLOW_KEY_PREFIX
  // instead of hard-coding 'flow_', so pin that flowKey() is still built from it.

  it('writes the current schema version into new flow records', async () => {
    const runId = 'abc126' as RunId;
    const store = getRunStore(runId);
    const flow = new PersistedFlow(new CompleteNode(), store, runId);

    await flow.run({ count: 0 });

    await expectStoredRecord(store, runId, {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      cursor: { nextNodeId: null, lastAction: 'complete' },
    });
  });

  it('replays from the persisted cursor, not from the start node', async () => {
    const runId = 'abc127' as RunId;
    const store = getRunStore(runId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, runId);

    await store.write(flowKey(runId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: { count: 0, continue: false },
      cursor: { nextNodeId: 'start/again', lastAction: 'again' },
    } satisfies FlowRecord);

    await flow.run({ count: 999, continue: true });

    await expectStoredRecord(store, runId, {
      shared: { count: 1, continue: false },
      cursor: { nextNodeId: null, lastAction: 'complete' },
    });
  });

  it('rejects a legacy no-cursor record loudly', async () => {
    const runId = 'abc128' as RunId;
    const store = getRunStore(runId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, runId);

    // Deliberately invalid: pre-cursor records are no longer supported.
    await store.write(flowKey(runId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      shared: { count: 1, continue: false },
    });

    await expect(flow.run({ count: 999, continue: true })).rejects.toThrow(
      /no replay cursor/,
    );
  });

  it('persists WAITING without advancing the replay cursor', async () => {
    const runId = 'abc129' as RunId;
    const store = getRunStore(runId);
    const flow = new PersistedFlow(new SuspendNode(), store, runId);

    await expect(flow.run({ count: 0 })).resolves.toBe(FlowTransition.WAITING);

    await expectStoredRecord(store, runId, {
      shared: { count: 1 },
      cursor: {
        nextNodeId: 'start',
        lastAction: FlowTransition.WAITING,
      },
    });

    await expect(flow.run({ count: 999 })).resolves.toBe(
      FlowTransition.WAITING,
    );
    await expectStoredRecord(store, runId, {
      shared: { count: 2 },
      cursor: {
        nextNodeId: 'start',
        lastAction: FlowTransition.WAITING,
      },
    });
  });
});
