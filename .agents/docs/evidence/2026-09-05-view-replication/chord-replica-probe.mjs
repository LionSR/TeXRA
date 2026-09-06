// Node built-in imports
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// Pi v0.85.1 source: d981de1229ef899957bbe968bc8dcda02a21f477.
// Pass an extracted archive or checkout root; no Pi dependency install is needed.
const piSourceRoot = process.argv[2];
if (!piSourceRoot)
  throw new Error('Usage: node --expose-gc PROBE.mjs PI_SOURCE_ROOT');
if (typeof global.gc !== 'function')
  throw new Error('Run this probe with --expose-gc');

const { applyImmutable } = await import(
  pathToFileURL(resolve(piSourceRoot, 'packages/chord/src/delta/index.ts')).href
);
const { ReplicatedStateReplica } = await import(
  pathToFileURL(resolve(piSourceRoot, 'packages/chord/src/services/state.ts'))
    .href
);
const { BACKGROUND_CONTEXT } = await import(
  pathToFileURL(resolve(piSourceRoot, 'packages/chord/src/context/index.ts'))
    .href
);

// Actual pinned Chord source; synthetic JSON transcript shapes. Only measures
// applyImmutable on prebuilt decoded operations. Excludes producers, codecs,
// transport, React, and business folds. Prior revisions retained or released.
const samples = [];
const iterations = 500;
const trials = 5;
const shape = (n) => ({
  messages: Array.from({ length: n }, (_, i) => ({
    id: String(i),
    content: [{ type: 'text', text: 'base' }],
  })),
  metadata: { title: 'test' },
});
for (const n of [100, 1000, 10000, 50000]) {
  for (const opCount of [1, 8]) {
    const ops = Array.from({ length: opCount }, (_, i) => [
      'a',
      ['messages', n - 1 - i, 'content', 0, 'text'],
      'x',
    ]);
    for (const retain of [false, true]) {
      const times = [];
      const heaps = [];
      for (let trial = 0; trial < trials; trial++) {
        globalThis.probeKeep = undefined;
        global.gc();
        const measure = () => {
          let current = shape(n);
          for (let i = 0; i < 100; i++) current = applyImmutable(current, ops);
          const retained = [];
          global.gc();
          const startHeap = process.memoryUsage().heapUsed;
          const start = performance.now();
          for (let i = 0; i < iterations; i++) {
            if (retain) retained.push(current);
            current = applyImmutable(current, ops);
          }
          const elapsedUs = ((performance.now() - start) * 1000) / iterations;
          // Explicit root keeps every retained revision reachable across GC.
          globalThis.probeKeep = { current, retained };
          global.gc();
          const heapMiB =
            (process.memoryUsage().heapUsed - startHeap) / 1024 / 1024;
          if (retain) {
            assert.equal(
              retained[0].messages[n - 1].content[0].text.length,
              104,
            );
            assert.equal(
              retained.at(-1).messages[n - 1].content[0].text.length,
              603,
            );
            assert.equal(current.messages[n - 1].content[0].text.length, 604);
            assert.notEqual(current.messages, retained.at(-1).messages);
            assert.equal(current.messages[0], retained[0].messages[0]);
            assert.equal(current.metadata, retained[0].metadata);
          }
          return { elapsedUs, heapMiB };
        };
        const result = measure();
        times.push(result.elapsedUs);
        heaps.push(result.heapMiB);
      }
      samples.push({
        messages: n,
        ops: opCount,
        retained: retain,
        medianUsPerBatch: times.toSorted((a, b) => a - b)[2],
        medianHeapGrowthMiB: heaps.toSorted((a, b) => a - b)[2],
      });
    }
  }
}
console.log(
  JSON.stringify(
    { node: process.version, iterations, trials, samples },
    null,
    2,
  ),
);

const replica = new ReplicatedStateReplica(() => {});
replica.hydrate(0, [['r', { a: 0 }]], BACKGROUND_CONTEXT);
assert.throws(() =>
  replica.update(
    1,
    [
      ['s', ['a'], 1],
      ['a', ['missing'], 'x'],
    ],
    BACKGROUND_CONTEXT,
  ),
);
assert.deepEqual(replica.value, { a: 0 }); // failed batch does not partially publish
replica.update(1, [['s', ['a'], 1]], BACKGROUND_CONTEXT); // failed apply retained prior sequence
assert.deepEqual(replica.value, { a: 1 });
assert.throws(
  () => replica.update(3, [['s', ['a'], 3]], BACKGROUND_CONTEXT),
  /gap/,
);
assert.equal(replica.value, undefined);
replica.hydrate(3, [['r', { a: 3 }]], BACKGROUND_CONTEXT);
assert.deepEqual(replica.value, { a: 3 });
console.log(
  'Correctness assertions passed: prior revisions and untouched identities preserved; failed apply preserves prior value/sequence; gap clears; explicit rehydrate recovers.',
);
