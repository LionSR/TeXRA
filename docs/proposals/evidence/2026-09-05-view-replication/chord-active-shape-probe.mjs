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

// Counterexample: immutable historical transcript beside small mutable active operation.
// Synthetic shape follows Pi's reducer placement, not actual Pi full-stack performance.
const shape = (n) => ({
  transcript: Array.from({ length: n }, (_, i) => ({
    id: String(i),
    text: 'past',
  })),
  operation: {
    streamingMessage: { content: [{ type: 'text', text: 'base' }] },
  },
});
const ops = [
  ['a', ['operation', 'streamingMessage', 'content', 0, 'text'], 'x'],
];
const samples = [];
for (const n of [1000, 10000, 50000]) {
  for (const retain of [false, true]) {
    const trials = [];
    for (let t = 0; t < 5; t++) {
      globalThis.keep = undefined;
      global.gc();
      const measure = () => {
        let current = shape(n);
        for (let i = 0; i < 100; i++) current = applyImmutable(current, ops);
        const retained = [];
        const transcript = current.transcript;
        global.gc();
        const heapStart = process.memoryUsage().heapUsed;
        const start = performance.now();
        for (let i = 0; i < 500; i++) {
          if (retain) retained.push(current);
          current = applyImmutable(current, ops);
        }
        const us = ((performance.now() - start) * 1000) / 500;
        globalThis.keep = { retained, current };
        global.gc();
        const heapMiB =
          (process.memoryUsage().heapUsed - heapStart) / 1024 / 1024;
        assert.equal(current.transcript, transcript);
        if (retain) {
          assert.equal(
            retained[0].operation.streamingMessage.content[0].text.length,
            104,
          );
          assert.equal(
            current.operation.streamingMessage.content[0].text.length,
            604,
          );
        }
        return { us, heapMiB };
      };
      trials.push(measure());
    }
    samples.push({
      historyMessages: n,
      retained: retain,
      medianUs: trials.map((t) => t.us).toSorted((a, b) => a - b)[2],
      medianHeapGrowthMiB: trials
        .map((t) => t.heapMiB)
        .toSorted((a, b) => a - b)[2],
    });
  }
}
console.log(
  JSON.stringify(
    { node: process.version, iterations: 500, trials: 5, samples },
    null,
    2,
  ),
);
console.log(
  'Assertions passed: historical transcript identity unchanged; retained active revisions unchanged.',
);
