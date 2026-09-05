/**
 * D5 experiment for #11864. Run with Node; bundles live sources into a temporary
 * directory and launches isolated workers with explicit GC enabled. Production
 * files are never rewritten. Published snapshots are checked before timing.
 */
// Node imports
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

// Third-party imports
import { build } from 'esbuild';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../../..');
const foldPath = join(root, 'src/shared/session/sessionFold.ts');
const runFile = promisify(execFile);
const MIB = 1024 ** 2;
const FRAME_MS = 16;

/** Replace one known source fragment; source drift fails the experiment. */
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Expected one ${before}`);
  return source.replace(before, after);
}

/**
 * Confined copy-on-touch variant. Private indexes remain single-owner working
 * state: this measures stable publications, not branching from an old view.
 * A touched transcript copies its three arrays once per frame. Other stream
 * fields already use replacement in the production fold.
 */
function copyOnTouchSource(source) {
  source = replaceOnce(
    source,
    'export function fold(',
    'function mutableFold(',
  );
  const mapWrite =
    /view\.(streams|policy|folded|latest|inflight|queuedFollowUps)\.(set|delete|clear)\(/g;
  assert.equal([...source.matchAll(mapWrite)].length, 17);
  source = source.replace(mapWrite, "writableMap(view, '$1').$2(");
  source = replaceOnce(
    source,
    '  INDEXES.set(next, indexesOf(transcript));',
    `  const indexes = indexesOf(transcript);
  next.rows = writableArray(next.rows);
  next.taskGroups = writableArray(next.taskGroups);
  next.compaction = writableArray(next.compaction);
  INDEXES.set(next, next.compaction === indexes.compactionState.blocks
    ? indexes
    : { ...indexes, compactionState: {
        ...indexes.compactionState, blocks: next.compaction,
      } });`,
  );
  return `${source}
// Experimental publication ownership, confined to this temporary module.
let ownedContainers = new WeakSet();
function writableArray(array) {
  if (ownedContainers.has(array)) return array;
  const copy = array.slice();
  ownedContainers.add(copy);
  return copy;
}
function writableMap(view, key) {
  const map = view[key];
  if (ownedContainers.has(map)) return map;
  const copy = new Map(map);
  if (key === 'streams') SESSION_INDEXES.set(copy, sessionIndexesOf(view));
  ownedContainers.add(copy);
  view[key] = copy;
  return copy;
}
export function fold(view, input) {
  ownedContainers = new WeakSet();
  return mutableFold(view, input);
}
`;
}

async function bundle(directory, variant) {
  const outfile = join(directory, `${variant}.mjs`);
  await build({
    stdin: {
      contents: `export { fold } from '@shared/session/sessionFold';
        export { emptySessionView } from '@shared/session/sessionView';
        export { Log, OWNER, ROOT, CHILD, GRANDCHILD, PROCESS, buildScenario,
          local, subscribe, tail } from './src/test-kernel/shared/session/fanOutScenario';
        export { AgentCategory, MESSAGE_TYPES, STREAM_LOG_ENTRY_TYPES,
          STREAM_PHASE } from '@shared/schemas';`,
      resolveDir: root,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(root, 'tsconfig.json'),
    plugins:
      variant === 'copy-on-touch'
        ? [
            {
              name: 'd5-copy-on-touch',
              setup(builder) {
                builder.onLoad({ filter: /\/sessionFold\.ts$/ }, async () => ({
                  contents: copyOnTouchSource(await readFile(foldPath, 'utf8')),
                  loader: 'ts',
                  resolveDir: dirname(foldPath),
                }));
              },
            },
          ]
        : [],
  });
  return outfile;
}

function serialize(value) {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Map ? [...item] : item,
  );
}

/** Exercise hierarchy, groups, approvals, compaction, text, and eviction. */
function verifyPublications(current, candidate) {
  const fixture = current.buildScenario({ proposal: true });
  const inputs = [...fixture.events, current.local({ self: [current.OWNER] })];
  const { log } = fixture;
  for (const state of ['started', 'completed']) {
    log.entry(current.CHILD, 20_000_000, {
      id: `compaction-${state}`,
      type: current.STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: current.MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      data: { operationId: 'd5-compaction', state },
    });
    inputs.push(current.tail(log.events.at(-1)));
  }
  log.entry(current.PROCESS, 20_000_001, {
    id: 'live',
    type: current.STREAM_LOG_ENTRY_TYPES.LOG,
    messageType: current.MESSAGE_TYPES.MODEL_RESPONSE,
    text: 'a',
    data: { status: 'running' },
  });
  inputs.push(current.tail(log.events.at(-1)));
  inputs.push({
    _tag: 'chunk',
    streamId: current.PROCESS,
    rowId: 'live',
    from: 1,
    to: 2,
    text: 'b',
  });
  inputs.push(current.subscribe(current.ROOT));
  const retained = [];
  let expected = current.emptySessionView('d5');
  let view = candidate.emptySessionView('d5');
  for (const input of inputs) {
    expected = current.fold(expected, [input]);
    const previous = view;
    view = candidate.fold(view, [input]);
    assert.equal(serialize(view), serialize(expected), 'Fold value changed');
    if (input._tag === 'chunk') {
      assert.equal(
        previous.streams.get(current.ROOT),
        view.streams.get(current.ROOT),
      );
      assert.notEqual(
        previous.streams.get(current.PROCESS).transcript.rows,
        view.streams.get(current.PROCESS).transcript.rows,
      );
    }
    retained.push([view, serialize(view)]);
  }
  for (const [snapshot, before] of retained) {
    assert.equal(serialize(snapshot), before, 'Retained publication mutated');
  }
  return {
    retainedPublications: retained.length,
    parity: true,
    immutable: true,
    untouchedStreamIdentity: true,
  };
}

/** Scale the fixture's aggregate ordering and parent/child event shape. */
function seed(api, options) {
  const log = new api.Log();
  const ids = Array.from(
    { length: options.streams },
    (_, i) => `d5-${i}#${i.toString(16).padStart(12, '0')}`,
  );
  for (const [i, id] of ids.entries()) {
    log.emit(id, 1_000 + i, {
      type: 'run.start',
      executionId: i.toString(16).padStart(12, '0'),
      identity: { kind: 'agent', agent: `custom:d5-${i}` },
      category: api.AgentCategory.ToolUse,
      isRemote: false,
      userFollowUpSupport: 'unsupported',
      ...(i % 32 === 0 ? {} : { parentStreamId: ids[i - (i % 32)] }),
    });
    log.emit(id, 1_000 + i, {
      type: 'status',
      phase: api.STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
      runStartedAt: 1_000 + i,
    });
    const count = i === ids.length - 1 ? options.longRows : options.rows;
    for (let row = 0; row < count; row += 1) {
      log.entry(id, 10_000 + row, {
        id: `row-${row}`,
        type: api.STREAM_LOG_ENTRY_TYPES.LOG,
        messageType: api.MESSAGE_TYPES.MODEL_RESPONSE,
        text: `Derivation ${row}: let x be a point of the domain.`,
        data: { status: 'completed' },
      });
    }
    log.entry(id, 100_000, {
      id: 'live',
      type: api.STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: api.MESSAGE_TYPES.MODEL_RESPONSE,
      text: 'a',
      data: { status: 'running' },
    });
  }
  return {
    ids,
    inputs: [
      api.subscribe(...ids),
      ...log.events.map(api.tail),
      api.local({ self: [api.OWNER] }),
    ],
  };
}

function frame(ids, index) {
  return ids.map((streamId) => ({
    _tag: 'chunk',
    streamId,
    rowId: 'live',
    from: 1 + index * 32,
    to: 1 + (index + 1) * 32,
    text: 'x'.repeat(31) + ' ',
  }));
}

function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
    above16ms: values.filter((value) => value > FRAME_MS).length,
  };
}

function collect() {
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

async function worker(bundlePath, options, workload) {
  const api = await import(pathToFileURL(bundlePath).href);
  const fixture = seed(api, options);
  const ids =
    workload === 'long-transcript'
      ? fixture.ids.slice(-1)
      : fixture.ids.slice(1, 33);
  // Warm the functions on an independent small session, then time cold replay
  // of an empty view. Module loading and fixture construction are excluded.
  const warm = seed(api, { streams: 64, rows: 8, longRows: 32 });
  api.fold(api.emptySessionView('warm'), warm.inputs);
  const cold = [];
  let view;
  for (let pass = 0; pass < 3; pass += 1) {
    collect();
    const before = performance.now();
    view = api.fold(api.emptySessionView('d5'), fixture.inputs);
    cold.push(performance.now() - before);
  }
  const transcriptRows = [...view.streams.values()].reduce(
    (sum, stream) => sum + stream.transcript.rows.length,
    0,
  );
  const inputs = Array.from({ length: options.frames }, (_, i) =>
    frame(ids, i),
  );
  const elapsed = [];
  const lateness = [];
  collect();
  const started = performance.now();
  for (const [i, input] of inputs.entries()) {
    const due = started + i * FRAME_MS;
    const delay = due - performance.now();
    if (delay > 0) await sleep(delay);
    lateness.push(Math.max(0, performance.now() - due));
    const before = performance.now();
    view = api.fold(view, input);
    elapsed.push(performance.now() - before);
  }
  const streamingHeapMiB = collect() / MIB;

  // Sampling runs separately so the profiler cannot change the timing result.
  view = api.fold(api.emptySessionView('d5-allocation'), fixture.inputs);
  collect();
  const inspector = new Session();
  inspector.connect();
  await inspector.post('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (const input of inputs) view = api.fold(view, input);
  const { profile } = await inspector.post('HeapProfiler.stopSampling');
  inspector.disconnect();
  const allocated = (node) =>
    node.selfSize +
    node.children.reduce((sum, child) => sum + allocated(child), 0);
  const retention = [];
  for (const count of new Set([1, 60, options.frames])) {
    const held = retainVersions(api, fixture.inputs, inputs, ids, count);
    view = held.view;
    const retainedHeap = collect();
    delete globalThis.d5RetainedVersions;
    const latestHeap = collect();
    assert.equal(view.streams.size, options.streams);
    retention.push({
      versions: count,
      distinctStreamMaps: held.distinctStreamMaps,
      distinctHotRowArrays: held.distinctHotRowArrays,
      additionalRetainedMiB: (retainedHeap - latestHeap) / MIB,
    });
  }

  return {
    workload,
    finalViewSha256: createHash('sha256').update(serialize(view)).digest('hex'),
    streams: options.streams,
    transcriptRows,
    coldInputs: fixture.inputs.length,
    chunksPerFrame: ids.length,
    frames: options.frames,
    nominalSeconds: (options.frames * FRAME_MS) / 1000,
    coldReplayMs: distribution(cold),
    frameFoldMs: distribution(elapsed),
    frameStartLatenessMs: distribution(lateness),
    streamingHeapMiB,
    sampledAllocatedMiB: allocated(profile.head) / MIB,
    samplingIntervalBytes: 32768,
    retention,
  };
}

/** Exit this scope before GC so temporary Sets cannot retain discarded views. */
function retainVersions(api, seedInputs, inputs, ids, count) {
  let view = api.fold(api.emptySessionView('d5-retention'), seedInputs);
  const versions = [];
  for (const input of inputs) {
    view = api.fold(view, input);
    versions.push(view);
    if (versions.length > count) versions.shift();
  }
  // The explicit root keeps every snapshot observable across the first GC.
  globalThis.d5RetainedVersions = versions;
  return {
    view,
    distinctStreamMaps: new Set(versions.map((value) => value.streams)).size,
    distinctHotRowArrays: new Set(
      versions.flatMap((value) =>
        ids.map((id) => value.streams.get(id).transcript.rows),
      ),
    ).size,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      streams: { type: 'string', default: '2048' },
      rows: { type: 'string', default: '24' },
      'long-rows': { type: 'string', default: '50000' },
      frames: { type: 'string', default: '600' },
    },
  });
  const options = {
    streams: Number(values.streams),
    rows: Number(values.rows),
    longRows: Number(values['long-rows']),
    frames: Number(values.frames),
  };
  for (const value of Object.values(options))
    assert.ok(Number.isInteger(value) && value > 0);
  assert.ok(options.streams >= 64 && options.frames >= 60);
  const cache = join(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'd5-fold-'));
  try {
    const currentPath = await bundle(directory, 'in-place');
    const candidatePath = await bundle(directory, 'copy-on-touch');
    const current = await import(pathToFileURL(currentPath).href);
    const candidate = await import(pathToFileURL(candidatePath).href);
    const verified = verifyPublications(current, candidate);
    const results = [];
    for (const [variant, bundlePath] of [
      ['in-place', currentPath],
      ['copy-on-touch', candidatePath],
    ]) {
      for (const workload of ['fanout-32', 'long-transcript']) {
        process.stderr.write(`Measuring ${variant}, ${workload}\n`);
        const result = await runFile(
          process.execPath,
          [
            '--expose-gc',
            script,
            '--worker',
            bundlePath,
            JSON.stringify(options),
            workload,
          ],
          { cwd: root, maxBuffer: 16 * MIB },
        );
        results.push({ variant, ...JSON.parse(result.stdout) });
      }
    }
    for (const workload of ['fanout-32', 'long-transcript']) {
      const rows = results.filter((result) => result.workload === workload);
      assert.equal(
        rows[0].finalViewSha256,
        rows[1].finalViewSha256,
        'Large-session output changed',
      );
    }
    const { stdout: revision } = await runFile('git', ['rev-parse', 'HEAD'], {
      cwd: root,
    });
    const report = {
      date: new Date().toISOString(),
      revision: revision.trim(),
      foldSha256: createHash('sha256')
        .update(await readFile(foldPath))
        .digest('hex'),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      memoryGiB: totalmem() / 1024 ** 3,
      options,
      verified,
      results,
    };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) await writeFile(resolve(values.output), json);
    process.stdout.write(json);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  process.stdout.write(
    JSON.stringify(
      await worker(
        process.argv[3],
        JSON.parse(process.argv[4]),
        process.argv[5],
      ),
    ),
  );
} else {
  await main();
}
