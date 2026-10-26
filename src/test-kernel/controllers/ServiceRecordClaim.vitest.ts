import { NodeFileSystem } from '@effect/platform-node';
import { it } from '@effect/vitest';
import { Deferred, Effect, FileSystem, Fiber, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { globalDatabaseLayer } from '@controllers/session/Database';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { GlobalValues } from '@platform/processRuntime';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { globalValuesOver } from '@test/support/setupPlatform';
import {
  claimServiceRecord,
  readServiceRecord,
} from '@texra/controllers/server/discovery';
import type { ServiceRecord } from '@texra/controllers/server/protocol';

const record = (pid: number): ServiceRecord => ({
  pid,
  protocol: 1,
  version: '1.0.0',
  socket: `/tmp/serve-${pid}.sock`,
  startedAt: pid,
});

/** The program over a real global root in a fresh temp directory. */
const withGlobalValues = <A, E>(program: Effect.Effect<A, E, GlobalValues>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storage = yield* fs.makeTempDirectoryScoped({
        prefix: 'texra-service-claim-',
      });
      return yield* program.pipe(
        Effect.provide(
          globalValuesOver(
            globalDatabaseLayer(storage).pipe(
              Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
              Layer.provide(nodeSpawnerLayer),
              Layer.orDie,
            ),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer));

/** Leaves `held` as the record a claim finds: it claims the empty root. */
const seed = (held: ServiceRecord) =>
  claimServiceRecord(held, () => Effect.succeed(null));

describe('claimServiceRecord', () => {
  it.live(
    'keeps the winner findable when a contender that probed the dead record commits late or never',
    () =>
      withGlobalValues(
        Effect.gen(function* () {
          const dead = record(1);
          yield* seed(dead);
          // A contender's probe answers for every record but the dead one.
          const live = (held: ServiceRecord) =>
            Effect.succeed(held.pid === dead.pid ? null : held.pid);
          // Two delayed contenders: each has probed the dead record and
          // stalls before its commit.
          const stalled = (gate: Deferred.Deferred<void>) => {
            const probed = Deferred.makeUnsafe<void>();
            const probe = (held: ServiceRecord) =>
              held.pid === dead.pid
                ? Deferred.succeed(probed, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.as(null),
                  )
                : live(held);
            return { probed, probe };
          };
          const interruptedGate = yield* Deferred.make<void>();
          const lateGate = yield* Deferred.make<void>();
          const interrupted = stalled(interruptedGate);
          const late = stalled(lateGate);
          const interruptedFiber = yield* Effect.forkChild(
            claimServiceRecord(record(2), interrupted.probe),
          );
          const lateFiber = yield* Effect.forkChild(
            claimServiceRecord(record(3), late.probe),
          );
          yield* Deferred.await(interrupted.probed);
          yield* Deferred.await(late.probed);

          // The winner claims while both stall.
          expect(yield* claimServiceRecord(record(4), live)).toBeNull();
          // One contender dies before its commit; the other commits late.
          yield* Fiber.interrupt(interruptedFiber);
          yield* Deferred.succeed(lateGate, undefined);
          // The late one finds the winner live and does not start.
          expect(yield* Fiber.join(lateFiber)).toBe(4);
          // A third client finds the winner.
          expect(yield* readServiceRecord).toEqual(record(4));
        }),
      ),
  );
});
