// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - node/flow primitives under test
import { BaseNode } from '@agent/node';
import {
  RoundPersistedFlow,
  type RoundAwareState,
} from '@agent/node/roundPersistedFlow';
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';

/**
 * Regression coverage for #7077: a compile failure on what would have been
 * the final round must get exactly one extra ("repair") round carrying the
 * failure context — gated on the reject-on-compile-failure setting, and
 * never granted twice even if the repair round itself fails again.
 *
 * These tests exercise `RoundPersistedFlow`'s round-continuation decision
 * directly (the single source of truth the fix touches), using a minimal
 * fake node and an in-memory KV store instead of standing up the full
 * reflection flow (model handler, prompt builder, LaTeX compile, etc).
 */

/** Minimal in-memory stand-in for ExecutionKVStore; only read/write/getExecutionId are exercised by PersistedFlow. */
function createFakeKv(): ExecutionKVStore {
  const store = new Map<string, unknown>();
  return {
    read: async <T>(key: string) => store.get(key) as T | undefined,
    write: async <T>(key: string, value: T) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    exists: async (key: string) => store.has(key),
    listKeys: async () => [...store.keys()],
    clear: async () => store.clear(),
    getExecutionId: () => 'test-exec-0001',
    readMeta: async () => null,
    readConfig: async () => null,
    readReport: async () => null,
    readTodos: async () => [],
    readConversation: async () => null,
    readWorkspaceFiles: async () => [],
    readChildren: async () => [],
    readResultMeta: async () => null,
    writeMeta: async () => {},
    writeConfig: async () => {},
    writeReport: async () => {},
    writeTodos: async () => {},
    writeConversation: async () => {},
    writeWorkspaceFiles: async () => {},
    writeChild: async () => {},
    writeResultMeta: async () => {},
  } as unknown as ExecutionKVStore;
}

interface FakeShared extends RoundAwareState {
  /** Round indices actually executed, in order. */
  roundsRun: number[];
  /** compileFailureContext observed by each executed round, if any. */
  contextSeenByRound: Record<number, string | undefined>;
  /** Round indices that should simulate a compile failure. */
  failingRounds: number[];
  /** Mirrors OutputNode's one-shot repair context (set on failure, consumed next round). */
  compileFailureContext?: string;
  /** Mirrors the persisted "already granted a repair round" flag. */
  compileRepairRoundGranted?: boolean;
  /** Mirrors the rejectOnCompileFailure setting. */
  rejectOnCompileFailureEnabled: boolean;
}

/**
 * A single node standing in for the whole reflection round (PrepareContext +
 * ... + OutputNode): it records the round it ran in, captures whatever
 * compileFailureContext it saw (mimicking PrepareContextNode consuming it),
 * then mimics OutputNode by setting a fresh compileFailureContext if this
 * round is scripted to fail compilation.
 */
class FakeRoundNode extends BaseNode<FakeShared> {
  async post(shared: FakeShared): Promise<undefined> {
    shared.roundsRun.push(shared.currentRound);
    shared.contextSeenByRound[shared.currentRound] =
      shared.compileFailureContext;
    delete shared.compileFailureContext;

    if (shared.failingRounds.includes(shared.currentRound)) {
      shared.compileFailureContext = `compile failed on round ${shared.currentRound}`;
    }
    return undefined;
  }
}

function makeFlow(kv: ExecutionKVStore) {
  const node = new FakeRoundNode();
  return new RoundPersistedFlow<FakeShared>(node, kv, {
    callbacks: {
      grantExtraRound: (s) => {
        if (
          !s.compileFailureContext ||
          s.compileRepairRoundGranted ||
          !s.rejectOnCompileFailureEnabled
        ) {
          return false;
        }
        s.compileRepairRoundGranted = true;
        return true;
      },
    },
  });
}

function initialShared(overrides: Partial<FakeShared>): FakeShared {
  return {
    currentRound: 0,
    totalRounds: 2,
    continueRounds: true,
    roundsRun: [],
    contextSeenByRound: {},
    failingRounds: [],
    rejectOnCompileFailureEnabled: true,
    ...overrides,
  };
}

describe('RoundPersistedFlow bounded compile-repair round (#7077)', () => {
  it('grants exactly one extra round when the final configured round fails to compile', async () => {
    const kv = createFakeKv();
    const flow = makeFlow(kv);
    // totalRounds: 2 (rounds 0 and 1 configured); round 1 (the last one) fails.
    const shared = initialShared({ totalRounds: 2, failingRounds: [1] });

    await flow.run(shared);
    const finalShared = (await flow.getShared())!;

    // Round 0, round 1 (configured, fails), and a granted repair round 2.
    expect(finalShared.roundsRun).toEqual([0, 1, 2]);
    // The repair round (2) received the failure context from round 1.
    expect(finalShared.contextSeenByRound[2]).toBe('compile failed on round 1');
    expect(finalShared.compileRepairRoundGranted).toBe(true);
  });

  it('does not grant an extra round when a clean final round has no failure context', async () => {
    const kv = createFakeKv();
    const flow = makeFlow(kv);
    const shared = initialShared({ totalRounds: 2, failingRounds: [] });

    await flow.run(shared);
    const finalShared = (await flow.getShared())!;

    expect(finalShared.roundsRun).toEqual([0, 1]);
    expect(finalShared.compileRepairRoundGranted).toBeUndefined();
  });

  it('does not grant an extra round when rejectOnCompileFailure is off', async () => {
    const kv = createFakeKv();
    const flow = makeFlow(kv);
    const shared = initialShared({
      totalRounds: 2,
      failingRounds: [1],
      rejectOnCompileFailureEnabled: false,
    });

    await flow.run(shared);
    const finalShared = (await flow.getShared())!;

    expect(finalShared.roundsRun).toEqual([0, 1]);
    expect(finalShared.compileRepairRoundGranted).toBeUndefined();
  });

  it('does not chain a second repair round when the repair round itself fails again', async () => {
    const kv = createFakeKv();
    const flow = makeFlow(kv);
    // Both the configured final round (1) and the granted repair round (2) fail.
    const shared = initialShared({ totalRounds: 2, failingRounds: [1, 2] });

    await flow.run(shared);
    const finalShared = (await flow.getShared())!;

    // Exactly one repair round (2) — no round 3, even though round 2 also failed.
    expect(finalShared.roundsRun).toEqual([0, 1, 2]);
    expect(finalShared.compileRepairRoundGranted).toBe(true);
  });
});
