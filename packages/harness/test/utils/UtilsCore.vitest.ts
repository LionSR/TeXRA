// Node imports
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Third-party imports
import { Effect, Fiber, FileSystem, Scheduler } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports - harness
import { deriveRunId } from '@utils/core/idHash';
import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { nodeFileServices } from '@utils/files/fsDurability';

describe('deriveRunId', () => {
  it('is stable across identity field order', () => {
    expect(deriveRunId({ parent: 'abc', attempt: 2 })).toBe(
      deriveRunId({ attempt: 2, parent: 'abc' }),
    );
  });
});

describe('withPerKeyLane', () => {
  it('frees the lane when its claimant is interrupted at any step', async () => {
    // A small budget makes the fiber yield every few steps, so one of the
    // paddings puts the yield between the claim and its release.
    for (let padding = 0; padding < 20; padding++) {
      const lanes = new Map<string, PerKeyLane>();
      const fiber = Effect.runFork(
        Effect.gen(function* () {
          for (let step = 0; step < padding; step++)
            yield* Effect.sync(() => {});
          yield* withPerKeyLane(lanes, 'key')(Effect.void);
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 8)),
      );
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(lanes.size, `padding ${padding}`).toBe(0);
    }
  });
});

describe('nodeFileServices', () => {
  it('finishes a write its fiber is interrupted in', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'texra-write-'));
    const target = path.join(directory, 'file.txt');
    writeFileSync(target, 'before');
    try {
      const after = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const write = yield* Effect.forkChild(
            fs.writeFileString(target, 'after'),
            { startImmediately: true },
          );
          yield* Fiber.interrupt(write);
          return yield* fs.readFileString(target);
        }).pipe(Effect.provide(nodeFileServices)),
      );
      expect(after).toBe('after');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
