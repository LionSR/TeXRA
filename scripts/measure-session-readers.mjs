/** Reproducible synthetic display workloads; no model/network calls or user data. */
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(
  new URL(`../.reader-measure-${process.pid}.mjs`, import.meta.url),
);
const source = `
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { frameSubscription } from './src/controllers/session/SessionFramer';
import { SessionFrames } from './src/shared/session/sessionFrames';
import { emptySessionView } from './src/shared/session/sessionView';
import { fold } from './src/shared/session/sessionFold';
import { sessionMessageBytes, SESSION_REPLAY_BYTES, SESSION_REPLAY_ROWS } from './src/shared/session/sessionReadBudget';
const key = 'measurement';
const aggregateId = '["stream","measurement"]';
const interests = [{ id: aggregateId, fromSeq: 0 }];
const scenarios = [
  { name: 'normal', rows: 1000, characters: 240 },
  { name: 'large', rows: 100000, characters: 240 },
  { name: 'large-retained-row', rows: 1, characters: 4 * 1024 * 1024 },
];
for (const scenario of scenarios) {
  globalThis.gc();
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  const sample = () => { const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); };
  const timer = setInterval(sample, 1);
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const frames = yield* SessionFrames;
    const published = yield* SubscriptionRef.make(emptySessionView(key));
    const host = yield* SubscriptionRef.make(null);
    let seq = 0;
    const stamp = (event) => ({ ...event, seq: ++seq, commit: seq, at: 1, ownerId: null, aggregateId });
    const start = stamp({ type: 'run.start', executionId: 'ab12cd', identity: { kind: 'agent', agent: 'chat' }, userFollowUpSupport: 'unsupported', category: 'toolUse', isRemote: false });
    const replay = [{ _tag: 'event', read: 'listing', event: start }];
    let sourceBytes = sessionMessageBytes(replay[0]);
    let largestRow = sourceBytes;
    for (let index = 0; index < scenario.rows; index += 1) {
      const input = { _tag: 'event', read: 'aggregate', event: stamp({ type: 'transcript.entry', entry: { type: 'log', id: 'row-' + index, seqNo: index + 1, timestamp: index + 1, level: 'info', messageType: 'modelResponse', text: index + ': ' + 'x'.repeat(scenario.characters) } }) };
      const bytes = sessionMessageBytes(input);
      sourceBytes += bytes;
      largestRow = Math.max(largestRow, bytes);
      if (sourceBytes > SESSION_REPLAY_BYTES || replay.length >= SESSION_REPLAY_ROWS) throw new Error('fixture exceeds declared source budget');
      replay.push(input);
    }
    replay.push({ _tag: 'replay.complete' });
    sample();
    yield* frames.begin(1);
    const consumer = yield* Effect.forkScoped(frames.inputs(interests).pipe(Stream.runForEach((batch) => SubscriptionRef.update(published, (view) => fold(view, batch)).pipe(Effect.tap(() => Effect.sync(sample))))));
    let count = 0;
    let maxBytes = 0;
    let maxRows = 0;
    const source = { key, view: published, inputs: () => Stream.make(replay), setTranscriptSubscriptions: () => Effect.void };
    yield* frameSubscription(source, 'measure', host, { kind: 'subscribe', session: key, generation: 1, cursor: 0, aggregates: interests }).pipe(
      Stream.takeUntil((frame) => frame.replayComplete),
      Stream.runForEach((frame) => Effect.gen(function* () {
        count += 1;
        maxBytes = Math.max(maxBytes, sessionMessageBytes(frame));
        maxRows = Math.max(maxRows, frame.events.length + frame.chunks.length);
        const done = yield* Deferred.make();
        const problem = yield* frames.feed(frame, () => Deferred.doneUnsafe(done, Effect.void));
        if (problem) throw new Error(problem.reason);
        yield* Deferred.await(done);
        sample();
      })),
    );
    yield* frames.stop;
    yield* Fiber.join(consumer);
    sample();
    const retained = SubscriptionRef.getUnsafe(published).streams.get('measurement')?.transcript.rows.length;
    if (retained !== scenario.rows) throw new Error('row loss: ' + retained + ' / ' + scenario.rows);
    return { name: scenario.name, retainedRows: retained, sourceBytes, largestRowBytes: largestRow, frames: count, maxFrameBytes: maxBytes, maxFrameRows: maxRows };
  }).pipe(Effect.provide(SessionFrames.layer))));
  clearInterval(timer);
  console.log(JSON.stringify({ ...result, baselineHeapBytes: baseline.heapUsed, peakHeapBytes: peakHeap, heapGrowthBytes: peakHeap - baseline.heapUsed, peakRssBytes: peakRss, rssGrowthBytes: peakRss - baseline.rss }));
}

// The healthy reader drains the same lazy source while a paused port holds
// its first frame. Source pulls expose any hidden aggregate/frame buffering.
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const host = yield* SubscriptionRef.make(null);
  const view = yield* SubscriptionRef.make(emptySessionView(key));
  const stalled = yield* Deferred.make();
  const released = yield* Deferred.make();
  const pulls = { paused: 0, healthy: 0 };
  const source = (reader) => ({ key, view, setTranscriptSubscriptions: () => Effect.void,
    inputs: () => Stream.fromIterable((function* () {
      for (let index = 1; index <= 100000; index += 1) {
        pulls[reader] += 1;
        yield [{ _tag: 'event', read: 'aggregate', event: { type: 'status', aggregateId, seq: index, commit: index, at: 1, ownerId: null, phase: 'running', cause: 'benchmark' } }];
      }
      yield [{ _tag: 'replay.complete' }];
    })(), { chunkSize: 1 }),
  });
  const subscribe = { kind: 'subscribe', session: key, generation: 1, cursor: 0, aggregates: interests };
  const slow = yield* Effect.forkScoped(frameSubscription(source('paused'), 'paused', host, subscribe).pipe(Stream.runForEach(() => Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(released))))));
  yield* Deferred.await(stalled);
  yield* Effect.sleep('50 millis');
  globalThis.gc();
  const start = process.memoryUsage();
  const pausedPullsBefore = pulls.paused;
  yield* frameSubscription(source('healthy'), 'healthy', host, subscribe).pipe(Stream.takeUntil((frame) => frame.replayComplete), Stream.runDrain);
  yield* Effect.sleep('50 millis');
  globalThis.gc();
  const end = process.memoryUsage();
  if (pulls.paused !== pausedPullsBefore) throw new Error('paused reader kept pulling');
  console.log(JSON.stringify({ name: 'paused-reader', healthyRows: pulls.healthy, pausedSourceRowsBefore: pausedPullsBefore, pausedSourceRowsAfter: pulls.paused, retainedFrames: 1, settledHeapBefore: start.heapUsed, settledHeapAfter: end.heapUsed, settledHeapChange: end.heapUsed - start.heapUsed, settledRssBefore: start.rss, settledRssAfter: end.rss }));
  yield* Fiber.interrupt(slow);
})));
`;
try {
  const bundle = await build({
    stdin: {
      contents: source,
      sourcefile: 'reader-measure.ts',
      resolveDir: root,
      loader: 'ts',
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    logLevel: 'silent',
  });
  await writeFile(output, bundle.outputFiles[0].contents);
  const result = spawnSync(process.execPath, ['--expose-gc', output], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(output, { force: true });
}
