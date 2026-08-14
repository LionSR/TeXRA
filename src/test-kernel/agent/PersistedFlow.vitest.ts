import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getExecutionStore } from '@agent/storage';
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
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

setupPlatform({ workspacePath: '/workspace' });

class CompleteNode extends BaseNode<{ count: number }> {
  async post(shared: { count: number }): Promise<string> {
    shared.count += 1;
    return 'complete';
  }
}

class ContinueOnceNode extends BaseNode<{ count: number; continue: boolean }> {
  async post(shared: { count: number; continue: boolean }): Promise<string> {
    shared.count += 1;
    return shared.continue ? 'again' : 'complete';
  }
}

class SuspendNode extends BaseNode<{ count: number }> {
  async post(shared: { count: number }): Promise<string> {
    shared.count += 1;
    return FlowTransition.WAITING;
  }
}

type ExecutionStore = ReturnType<typeof getExecutionStore>;

function expectStoredRecord(
  store: ExecutionStore,
  executionId: ExecutionId,
  expected: Record<string, unknown>,
): Promise<void> {
  return expect(
    store.read<FlowRecord>(flowKey(executionId)),
  ).resolves.toMatchObject(expected);
}

describe('PersistedFlow', () => {
  // Regression for the executionKvFiles leak fix: consumers that recognize a
  // flow record's KV filename (e.g. `isKVFile`) now import FLOW_KEY_PREFIX
  // instead of hard-coding 'flow_', so pin that flowKey() is still built from it.
  it('builds the flow key from the exported FLOW_KEY_PREFIX', () => {
    const executionId = 'abc125' as ExecutionId;
    expect(flowKey(executionId)).toBe(`${FLOW_KEY_PREFIX}${executionId}`);
  });

  it('writes the current schema version into new flow records', async () => {
    const executionId = 'abc126' as ExecutionId;
    const store = getExecutionStore(executionId);
    const flow = new PersistedFlow(new CompleteNode(), store, executionId);

    await flow.run({ count: 0 });

    await expectStoredRecord(store, executionId, {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      cursor: { nextNodeId: null, lastAction: 'complete' },
      nodes: [{ action: 'complete' }],
    });
  });

  it('replays from the cursor rather than the audit node log', async () => {
    const executionId = 'abc127' as ExecutionId;
    const store = getExecutionStore(executionId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, executionId);

    await store.write(flowKey(executionId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      flowName: 'texra',
      shared: { count: 0, continue: false },
      createdAt: new Date().toISOString(),
      cursor: { nextNodeId: 'start/again', lastAction: 'again' },
      nodes: [],
    } satisfies FlowRecord);

    await flow.run({ count: 999, continue: true });

    await expectStoredRecord(store, executionId, {
      shared: { count: 1, continue: false },
      cursor: { nextNodeId: null, lastAction: 'complete' },
      nodes: [{ action: 'complete', nodeId: 'start/again' }],
    });
  });

  it('rejects a legacy no-cursor record loudly instead of replaying the node log', async () => {
    const executionId = 'abc128' as ExecutionId;
    const store = getExecutionStore(executionId);
    const first = new ContinueOnceNode();
    const second = new CompleteNode();
    first.on('again', second);
    const flow = new PersistedFlow(first, store, executionId);

    // Deliberately invalid: pre-cursor records are no longer supported.
    await store.write(flowKey(executionId), {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      flowName: 'texra',
      shared: { count: 1, continue: false },
      createdAt: new Date().toISOString(),
      nodes: [{ action: 'again' }],
    });

    await expect(flow.run({ count: 999, continue: true })).rejects.toThrow(
      /no replay cursor/,
    );
  });

  it('persists WAITING without advancing the replay cursor', async () => {
    const executionId = 'abc129' as ExecutionId;
    const store = getExecutionStore(executionId);
    const flow = new PersistedFlow(new SuspendNode(), store, executionId);

    await expect(flow.run({ count: 0 })).resolves.toBe(FlowTransition.WAITING);

    await expectStoredRecord(store, executionId, {
      shared: { count: 1 },
      cursor: {
        nextNodeId: 'start',
        lastAction: FlowTransition.WAITING,
      },
      nodes: [{ action: FlowTransition.WAITING, nodeId: 'start' }],
    });

    await expect(flow.run({ count: 999 })).resolves.toBe(
      FlowTransition.WAITING,
    );
    await expectStoredRecord(store, executionId, {
      shared: { count: 2 },
      cursor: {
        nextNodeId: 'start',
        lastAction: FlowTransition.WAITING,
      },
    });
  });

  it('persists flow records as compact JSON', async () => {
    const executionId = 'abc130' as ExecutionId;
    const store = getExecutionStore(executionId);

    await new PersistedFlow(new CompleteNode(), store, executionId).run({
      count: 0,
    });

    const raw = await StorageFS.read(
      resolveRunStoragePath(executionId, `${flowKey(executionId)}.json`),
    );
    expect(raw).toContain('"schemaVersion"');
    expect(raw).not.toContain('\n');
  });

  it('parses shared through the schema only at the deserialization boundary', async () => {
    const executionId = 'abc131' as ExecutionId;
    const store = getExecutionStore(executionId);
    interface Shared {
      count: number;
      continue: boolean;
    }
    let parses = 0;
    const schema: z.ZodType<Shared> = z
      .object({ count: z.number(), continue: z.boolean() })
      .refine(() => {
        parses += 1;
        return true;
      });
    const buildFlow = () => {
      const first = new ContinueOnceNode();
      first.on('again', new CompleteNode());
      return new PersistedFlow(first, store, executionId, schema);
    };

    // A fresh run owns every record it writes: no re-parse per transition.
    await buildFlow().run({ count: 0, continue: true });
    expect(parses).toBe(0);

    // A new instance hits the true deserialization boundary exactly once,
    // and getShared() returns the record's live object, not a copy.
    const resumed = buildFlow();
    const shared = await resumed.getShared();
    expect(shared).toEqual({ count: 2, continue: true });
    expect(parses).toBe(1);
    await expect(resumed.getShared()).resolves.toBe(shared);
    expect(parses).toBe(1);
  });
});
