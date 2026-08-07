// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { BaseNode } from '@agent/node';
import {
  RoundPersistedFlow,
  type RoundAwareState,
} from '@agent/implementations/flows/reflection/RoundPersistedFlow';
import { computeRoundStageTotal } from '@agent/implementations/flows/reflection/runReflectionFlow';
import type { ExecutionKVStore } from '@agent/storage/ExecutionKVStore';
import { createFakeKv } from '@test/support/FakeExecutionKVStore';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

/**
 * Regression coverage for the reviewer finding on PR #7290 (issue #7077's
 * bounded compile-repair round): when the repair round is granted,
 * `currentRound` becomes `totalRounds` (one index past the configured last
 * round). `runReflectionFlow.ts`'s `createRoundStage` callback widens the
 * stage's `total` for that round via the exported `computeRoundStageTotal`
 * so the webview progress badge never displays an over-total round count
 * like "Round 3 of 2".
 *
 * These tests exercise the REAL `computeRoundStageTotal` (not a local copy
 * of its formula) against `RoundPersistedFlow` (the same mechanics
 * `RoundPersistedFlowCompileRepair.vitest.ts` exercises) to confirm the
 * repair round really is opened with the widened total, then feed the
 * resulting stage through the actual webview badge formatters to confirm
 * the rendered badge stays sensible rather than over-total.
 */

interface FakeShared extends RoundAwareState {
  failingRounds: number[];
  compileFailureContext?: string;
  compileRepairRoundGranted?: boolean;
}

class FakeRoundNode extends BaseNode<FakeShared> {
  async post(shared: FakeShared): Promise<undefined> {
    delete shared.compileFailureContext;
    if (shared.failingRounds.includes(shared.currentRound)) {
      shared.compileFailureContext = `compile failed on round ${shared.currentRound}`;
    }
    return undefined;
  }
}

/** Stages opened via `createRoundStage`, captured in call order. */
type CapturedStage = { index: number; total: number | undefined };

function makeFlowWithStageCapture(
  kv: ExecutionKVStore,
  capturedStages: CapturedStage[],
) {
  const node = new FakeRoundNode();
  return new RoundPersistedFlow<FakeShared>(node, kv, {
    callbacks: {
      // Mirrors runReflectionFlow.ts's createRoundStage callback, using the
      // SAME exported computeRoundStageTotal (not a local reimplementation)
      // so this test actually fails if the real widening logic regresses.
      createRoundStage: (roundIndex, _parent, shared) => {
        const total = computeRoundStageTotal(shared.totalRounds, roundIndex);
        capturedStages.push({ index: roundIndex, total });
        return {
          id: `r${roundIndex}`,
          end: () => {},
          within: (fn) => Promise.resolve(fn()),
          run: (fn) => Promise.resolve(fn()),
          child: () => {
            throw new Error('not used in this test');
          },
        };
      },
      grantExtraRound: (s) => {
        if (!s.compileFailureContext || s.compileRepairRoundGranted) {
          return false;
        }
        s.compileRepairRoundGranted = true;
        return true;
      },
    },
  });
}

describe('repair-round progress badge (PR #7290 follow-up)', () => {
  it('widens the stage total for the granted repair round instead of leaving it stuck at the configured total', async () => {
    const kv = createFakeKv();
    const capturedStages: CapturedStage[] = [];
    const flow = makeFlowWithStageCapture(kv, capturedStages);
    const shared: FakeShared = {
      currentRound: 0,
      totalRounds: 2,
      continueRounds: true,
      failingRounds: [1],
    };

    await flow.run(shared);

    // Round 0, round 1 (configured, fails), and a granted repair round 2.
    expect(capturedStages).toEqual([
      { index: 0, total: 2 },
      { index: 1, total: 2 },
      // Without the fix this would be `{ index: 2, total: 2 }` — the repair
      // round opening with index === total.
      { index: 2, total: 3 },
    ]);
  });

  describe('badge formatters given the repair round stage', () => {
    useLitComponentTestDom();

    it('renders a sensible, non-over-total badge for the widened repair-round stage', async () => {
      const { renderProgressBadgeContent, getProgressBadgeTitle } =
        await import('@progressView/frontend/formatters/progressBadgeFormatter');
      const { render } = await import('lit');

      // The repair round as opened by the fixed createRoundStage callback:
      // index 2 (0-based, the round past the configured totalRounds: 2),
      // total widened to 3 via Math.max(totalRounds, roundIndex + 1).
      const stage = { kind: 'round', index: 2, total: 3 } as const;

      const container = document.createElement('div');
      render(renderProgressBadgeContent(undefined, stage), container);
      expect(container.textContent).toBe('r3/3');
      expect(getProgressBadgeTitle(undefined, stage)).toBe('Round 3 of 3');
    });
  });
});
