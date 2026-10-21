import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { nodeFileServices } from '@texra-ai/harness/node';
import {
  claimServiceRecord,
  prepareServiceDirectories,
  servicePaths,
  type ServiceRecord,
} from '@texra/controllers/server/discovery';

const record = (pid: number): ServiceRecord => ({
  pid,
  protocol: 1,
  version: '1.0.0',
  socket: `/tmp/serve-${pid}.sock`,
  startedAt: pid,
});

describe('claimServiceRecord', () => {
  it.live(
    'publishes exactly one of the services that start at once over a dead record',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), 'texra-service-claim-')),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const paths = servicePaths(root);
        yield* prepareServiceDirectories(paths);
        const dead = record(1);
        yield* Effect.promise(() =>
          writeFile(paths.record, JSON.stringify(dead)),
        );
        // Every contender's record names a live service; the dead one's
        // socket accepts nothing.
        const retired = new Set<number>();
        const holder = {
          probe: (held: ServiceRecord) =>
            Effect.succeed(held.pid === dead.pid ? null : held.pid),
          retire: (held: ServiceRecord) =>
            Effect.sync(() => void retired.add(held.pid)),
        };
        const contenders = [2, 3, 4, 5];
        const answers = yield* Effect.all(
          contenders.map((pid) =>
            claimServiceRecord(paths, record(pid), holder),
          ),
          { concurrency: 'unbounded' },
        );
        const published: ServiceRecord = JSON.parse(
          yield* Effect.promise(() => readFile(paths.record, 'utf8')),
        );
        // One contender holds the record; any other that claimed was
        // displaced, and retired.
        const serving = contenders.filter(
          (pid, index) => answers[index] === null && !retired.has(pid),
        );
        expect(serving).toEqual([published.pid]);
      }).pipe(Effect.provide(nodeFileServices)),
  );
});
