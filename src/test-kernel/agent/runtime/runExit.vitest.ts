// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { recordHalt } from '@agent/runtime/loop/runExit';
import { RUN_OUTCOME, RUN_PHASE, type RunId } from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { generateRunId } from '@utils/core';

function makeRunId(): RunId {
  return generateRunId() as RunId;
}

function makeOpenedState(): RunState {
  return {
    family: 'toolUse',
    phase: RUN_PHASE.RUNNING,
    round: 2,
    turn: 3,
    continuationIndex: 1,
  } as unknown as RunState;
}

describe('recordHalt', () => {
  it.effect('warns and succeeds when the ledger refuses the halt write', () =>
    Effect.gen(function* () {
      const runId = makeRunId();
      const openedState = makeOpenedState();
      const refusal = new RunLedgerRefused({
        reason: 'not-owner',
        runId,
        detail: 'claim moved',
      });
      const appendBatch = vi.fn(() => Effect.fail(refusal));
      const warn = vi.fn();

      const halt = recordHalt(
        {
          ledger: { appendBatch } as never,
          logger: { warn } as never,
          runId,
        },
        (state) => state,
      );

      yield* halt(openedState, RUN_OUTCOME.CANCELLED);

      expect(appendBatch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('Failed to record the run halt', {
        data: refusal,
      });
    }),
  );

  it.effect(
    'fails on database write errors without downgrading them to warnings',
    () =>
      Effect.gen(function* () {
        const runId = makeRunId();
        const openedState = makeOpenedState();
        const failure = new DatabaseWriteFailed({
          path: 'session.db',
          cause: new Error('disk full'),
        });
        const appendBatch = vi.fn(() => Effect.fail(failure));
        const warn = vi.fn();

        const halt = recordHalt(
          {
            ledger: { appendBatch } as never,
            logger: { warn } as never,
            runId,
          },
          (state) => state,
        );

        expect(yield* Effect.flip(halt(openedState, RUN_OUTCOME.FAILED))).toBe(
          failure,
        );
        expect(appendBatch).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
      }),
  );

  it.effect('dies on defects that are not typed halt-write failures', () =>
    Effect.gen(function* () {
      const runId = makeRunId();
      const openedState = makeOpenedState();
      const defect = new Error('unexpected halt defect');
      const appendBatch = vi.fn(() => Effect.die(defect));
      const warn = vi.fn();

      const halt = recordHalt(
        {
          ledger: { appendBatch } as never,
          logger: { warn } as never,
          runId,
        },
        (state) => state,
      );

      const exit = yield* Effect.exit(halt(openedState, RUN_OUTCOME.FAILED));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
      expect(appendBatch).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    }),
  );
});
