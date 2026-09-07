/** Pre-cutover runtime budgets against the surviving `Database` contract; synthetic events only, no model/network calls or user data. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
// The bundle keeps `packages: 'external'`, so Node resolves `effect` and the
// other bare specifiers upward from the bundle's own directory. Only a path
// inside the repository reaches the workspace `node_modules`; `os.tmpdir()`
// would die on the first `import { Effect } from 'effect'`.
const cache = join(root, 'node_modules/.cache/texra-measure');
const output = join(cache, `runtime-baseline-${process.pid}.mjs`);

const source = `
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { hostname, loadavg } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Effect, Layer } from 'effect';
import { databaseLayer } from './src/controllers/session/Database';
import { WorkspaceRoots } from './src/controllers/session/WorkspaceRoots';
import { aggregateId } from './src/shared/schemas/sessionEvent';
import { Database } from './src/shared/session/database';
import { ProcessIdentity } from './src/shared/session/sessionEvents';

const [role, ...args] = process.argv.slice(2);
const owner = JSON.stringify([hostname().toLowerCase(), process.pid, 'measure']);

/** Every scenario reaches SQLite through the same service the cutover keeps. */
const substrate = (storage) =>
  databaseLayer('persistent').pipe(
    Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
    Layer.provide(ProcessIdentity.layer(owner)),
    Layer.fresh,
  );

const withDatabase = (storage, program) =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(program).pipe(Effect.provide(substrate(storage)))),
  );

const stream = (id) => aggregateId('stream', id);

// \`run.start\` also claims \`["execution", executionId]\`, so a shared literal
// would collide the moment two streams, or two processes on one file, start.
let executions = 0;
const nextExecutionId = () => {
  executions += 1;
  return ('00000' + process.pid.toString(16)).slice(-6) + '-' + executions.toString(16);
};

const runStart = (id) => ({
  type: 'run.start',
  aggregateId: stream(id),
  executionId: nextExecutionId(),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: 'toolUse',
  isRemote: false,
});

const status = (id, cause) => ({
  type: 'status',
  aggregateId: stream(id),
  phase: 'running',
  cause,
});

const transcriptRow = (id, index, characters) => ({
  type: 'transcript.entry',
  aggregateId: stream(id),
  entry: {
    type: 'log',
    id: 'row-' + index,
    seqNo: index + 1,
    timestamp: index + 1,
    level: 'info',
    messageType: 'modelResponse',
    text: index + ': ' + 'x'.repeat(characters),
  },
});

// Monotonic and zeroed at process start, so the cold-open scenario can also
// report the wall time a fresh process spent before its first listing.
const nowMs = () => performance.now();

/** Nearest-rank percentile over a sorted-in-place copy; empty input is a defect. */
const percentile = (values, fraction) => {
  if (values.length === 0) throw new Error('percentile over no samples');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
};

const latencySummary = (samples) => ({
  samples: samples.length,
  p50Ms: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  p99Ms: percentile(samples, 0.99),
  maxMs: Math.max(...samples),
});

/**
 * An independent fixed-rate probe. The gate asks how much OTHER work SQLite
 * delays, so the reported number is this probe's lateness against its own
 * schedule, never the append loop's own latency. \`monitorEventLoopDelay\`
 * runs beside it as a libuv-level cross-check.
 */
const startProbe = (periodMs) => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  // Per-tick lateness, not lateness against an absolute schedule: Node arms
  // the next \`setInterval\` fire after the callback returns, so an absolute
  // schedule accumulates ordinary drift and would report it as delay.
  let previous = nowMs();
  const late = [];
  const timer = setInterval(() => {
    const tick = nowMs();
    late.push(Math.max(tick - previous - periodMs, 0));
    previous = tick;
  }, periodMs);
  return {
    stop: () => {
      clearInterval(timer);
      histogram.disable();
      if (late.length === 0) throw new Error('probe recorded no ticks');
      return {
        probePeriodMs: periodMs,
        probeTicks: late.length,
        probeLatenessMs: latencySummary(late),
        loopDelayMeanMs: histogram.mean / 1e6,
        loopDelayP95Ms: histogram.percentile(95) / 1e6,
        loopDelayMaxMs: histogram.max / 1e6,
      };
    },
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every record carries the load it was taken under, because a number from a
// busy machine is not a budget.
const emit = (record) =>
  console.log(JSON.stringify({ ...record, loadAverage1m: loadavg()[0] }));

/** Append \`rows\` synthetic transcript rows and report what the batch cost. */
const appendHistory = (db, id, rows, characters, batchSize) =>
  Effect.gen(function* () {
    const latencies = [];
    let appended = 0;
    yield* db.appendAll([runStart(id)]);
    while (appended < rows) {
      const size = Math.min(batchSize, rows - appended);
      const drafts = [];
      for (let index = 0; index < size; index += 1)
        drafts.push(transcriptRow(id, appended + index, characters));
      const start = nowMs();
      const committed = yield* db.appendAll(drafts);
      latencies.push(nowMs() - start);
      if (committed.length !== size)
        throw new Error('partial commit: ' + committed.length + ' / ' + size);
      appended += size;
    }
    return { appended, latencies };
  });

const databaseBytes = (storage) => {
  const sizeOf = (suffix) => {
    try {
      return statSync(join(storage, 'texra.db' + suffix)).size;
    } catch (cause) {
      // Absent only for the WAL sidecars before the first checkpoint; the
      // main file must exist, and its absence is a real failure.
      if (suffix === '') throw cause;
      return 0;
    }
  };
  return {
    dbBytes: sizeOf(''),
    walBytes: sizeOf('-wal'),
    shmBytes: sizeOf('-shm'),
  };
};

if (role === 'seed') {
  const [storage, rows, characters] = [args[0], Number(args[1]), Number(args[2])];
  const result = await withDatabase(storage, function* () {
    const db = yield* Database;
    const written = yield* appendHistory(db, 'seed', rows, characters, 500);
    const commit = yield* db.currentCommit;
    if (commit !== written.appended + 1)
      throw new Error('commit ordinal ' + commit + ' for ' + written.appended + ' rows');
    return { rows: written.appended, commit, latencies: written.latencies };
  });
  emit({
    scenario: 'seed',
    historyRows: result.rows,
    historyCommit: result.commit,
    batchRows: 500,
    batchCommitLatencyMs: latencySummary(result.latencies),
    ...databaseBytes(storage),
  });
}

// Cold open: a fresh process opening an existing session database, through
// \`databaseLayer\` and nothing else, to its first usable listing. This is the
// substrate half of the gate's "cold open"; the host launch around it has no
// harness in this repository and is recorded as unmeasured.
if (role === 'open') {
  const [storage, historyRows] = [args[0], Number(args[1])];
  const before = nowMs();
  const opened = await withDatabase(storage, function* () {
    const db = yield* Database;
    const ready = nowMs();
    const listing = yield* db.readListing();
    const listed = nowMs();
    return { ready, listed, listingRows: listing.length };
  });
  // Includes Node boot and evaluating the bundled module graph, which is
  // the floor any host pays before its first session read.
  const processStartToListingMs = nowMs();
  globalThis.gc();
  await sleep(400);
  globalThis.gc();
  const idle = process.memoryUsage();
  emit({
    scenario: 'cold-open',
    historyRows,
    layerBuildMs: opened.ready - before,
    firstListingMs: opened.listed - opened.ready,
    openToListingMs: opened.listed - before,
    processStartToListingMs,
    listingRows: opened.listingRows,
    idleHeapBytes: idle.heapUsed,
    idleRssBytes: idle.rss,
    idleExternalBytes: idle.external,
  });
}

// Replay memory: the same fresh-process open, then the whole history through
// \`readAll\`, which is what a mounting reader pays for.
if (role === 'replay') {
  const [storage, historyRows] = [args[0], Number(args[1])];
  globalThis.gc();
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  };
  const timer = setInterval(sample, 1);
  const result = await withDatabase(storage, function* () {
    const db = yield* Database;
    sample();
    const start = nowMs();
    const events = yield* db.readAll(0);
    const readMs = nowMs() - start;
    sample();
    if (events.length !== historyRows + 1)
      throw new Error('replay read ' + events.length + ' of ' + (historyRows + 1));
    const inputStart = nowMs();
    const batch = yield* db.readInputBatch([stream('seed')], 0);
    const inputBatchMs = nowMs() - inputStart;
    sample();
    const bytes = events.reduce((total, event) => total + JSON.stringify(event).length, 0);
    return { rows: events.length, readMs, inputBatchMs, inputBatchRows: batch.events.length, bytes };
  });
  clearInterval(timer);
  globalThis.gc();
  const settled = process.memoryUsage();
  emit({
    scenario: 'replay-memory',
    historyRows,
    replayRows: result.rows,
    replayMs: result.readMs,
    readInputBatchMs: result.inputBatchMs,
    readInputBatchRows: result.inputBatchRows,
    decodedJsonBytes: result.bytes,
    baselineHeapBytes: baseline.heapUsed,
    peakHeapBytes: peakHeap,
    heapGrowthBytes: peakHeap - baseline.heapUsed,
    peakRssBytes: peakRss,
    settledHeapBytes: settled.heapUsed,
  });
}

// The contender. A second OS process holding its own connection to the same
// file is what makes \`busy_timeout\` and the WAL writer lock real; a second
// fiber in one process would only queue behind the single write permit.
if (role === 'contend') {
  const [storage, durationMs] = [args[0], Number(args[1])];
  const committed = await withDatabase(storage, function* () {
    const db = yield* Database;
    const id = 'contender-' + process.pid;
    yield* db.appendAll([runStart(id)]);
    const deadline = nowMs() + durationMs;
    let rows = 0;
    while (nowMs() < deadline) {
      yield* db.appendAll([transcriptRow(id, rows, 512)]);
      rows += 1;
      yield* Effect.sleep('1 millis');
    }
    return rows;
  });
  emit({ scenario: 'contender', contenderRows: committed });
}

if (role === 'loop') {
  const [storage, writers, durationMs] = [args[0], Number(args[1]), Number(args[2])];
  await withDatabase(storage, function* () {
    const db = yield* Database;

    const quiet = startProbe(10);
    yield* Effect.promise(() => sleep(2000));
    emit({ scenario: 'loop-delay', phase: 'idle', writers: 0, contender: false, ...quiet.stop() });

    const contender = spawn(
      process.execPath,
      [process.argv[1], 'contend', storage, String(durationMs + 2000)],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    const contenderExit = new Promise((resolve, reject) => {
      contender.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('contender exited ' + code)),
      );
      contender.on('error', reject);
    });
    yield* Effect.promise(() => sleep(1500));

    const commitBefore = yield* db.currentCommit;
    const loaded = startProbe(10);
    const deadline = nowMs() + durationMs;
    const latencies = [];
    const append = (writer) =>
      Effect.gen(function* () {
        const id = 'writer-' + writer;
        yield* db.appendAll([runStart(id)]);
        let rows = 0;
        while (nowMs() < deadline) {
          const start = nowMs();
          yield* db.appendAll([transcriptRow(id, rows, 512)]);
          latencies.push(nowMs() - start);
          rows += 1;
          yield* Effect.yieldNow;
        }
        return rows;
      });
    const written = yield* Effect.all(
      Array.from({ length: writers }, (_, writer) => append(writer)),
      { concurrency: 'unbounded' },
    );
    const under = loaded.stop();
    const commitAfter = yield* db.currentCommit;
    yield* Effect.promise(() => contenderExit);

    const ownRows = written.reduce((total, rows) => total + rows + 1, 0);
    const contenderRows = commitAfter - commitBefore - ownRows;
    if (contenderRows <= 0)
      throw new Error('no cross-process contention: ' + contenderRows + ' foreign commits');
    emit({
      scenario: 'loop-delay',
      phase: 'loaded',
      writers,
      contender: true,
      durationMs,
      ownCommits: ownRows,
      foreignCommits: contenderRows,
      commitLatencyMs: latencySummary(latencies),
      ...under,
    });
  });
}

// Two papers are two session roots, so two \`databaseLayer\` instances and two
// SQLite files. The gate asks whether one paper's writes cost the other.
if (role === 'twopaper') {
  const [alone, first, second, durationMs] = [args[0], args[1], args[2], Number(args[3])];
  const drive = (storage, id, deadline, foreignIds) =>
    withDatabase(storage, function* () {
      const db = yield* Database;
      yield* db.appendAll([runStart(id)]);
      const latencies = [];
      let rows = 0;
      while (nowMs() < deadline) {
        const start = nowMs();
        yield* db.appendAll([transcriptRow(id, rows, 512)]);
        latencies.push(nowMs() - start);
        rows += 1;
        yield* Effect.yieldNow;
      }
      // One paper's database must not hold the other's rows. A root is a
      // separate SQLite file, and that is the isolation the gate asks about.
      const events = yield* db.readAll(0);
      const leaked = events.filter((event) =>
        foreignIds.some((foreign) => event.aggregateId === stream(foreign)),
      );
      if (leaked.length > 0)
        throw new Error('paper isolation broken: ' + leaked.length + ' foreign rows');
      return { rows, latencies, storedRows: events.length };
    });

  const soloProbe = startProbe(10);
  const solo = await drive(alone, 'solo', nowMs() + durationMs, ['pair-a', 'pair-b']);
  emit({
    scenario: 'two-paper',
    phase: 'one-paper',
    papers: 1,
    committedRows: solo.rows,
    commitLatencyMs: latencySummary(solo.latencies),
    ...soloProbe.stop(),
  });

  const pairProbe = startProbe(10);
  const deadline = nowMs() + durationMs;
  const [a, b] = await Promise.all([
    drive(first, 'pair-a', deadline, ['solo', 'pair-b']),
    drive(second, 'pair-b', deadline, ['solo', 'pair-a']),
  ]);
  emit({
    scenario: 'two-paper',
    phase: 'two-papers',
    papers: 2,
    committedRows: a.rows + b.rows,
    firstPaperRows: a.rows,
    secondPaperRows: b.rows,
    commitLatencyMs: latencySummary([...a.latencies, ...b.latencies]),
    ...pairProbe.stop(),
  });
}

// Bytes written as history grows: on-disk cost per appended row, for a plain
// status row and for a 256 KiB transcript row standing in for retained media.
if (role === 'bytes') {
  const [storage, tranches, perTranche] = [args[0], Number(args[1]), Number(args[2])];
  for (const shape of [
    { name: 'status', characters: 0, rows: perTranche },
    { name: 'transcript-1kib', characters: 1024, rows: perTranche },
    { name: 'transcript-256kib', characters: 256 * 1024, rows: Math.max(Math.floor(perTranche / 100), 1) },
  ]) {
    // One database per shape: a shared file would attribute the previous
    // shape's pages to this one's rows.
    const root = join(storage, shape.name);
    const written = await withDatabase(root, function* () {
      const db = yield* Database;
      const id = 'bytes-' + shape.name;
      yield* db.appendAll([runStart(id)]);
      let payloadBytes = 0;
      let rows = 0;
      for (let tranche = 0; tranche < tranches; tranche += 1) {
        const drafts = [];
        for (let index = 0; index < shape.rows; index += 1) {
          const draft =
            shape.characters === 0
              ? status(id, 'tranche-' + tranche + '-' + index)
              : transcriptRow(id, rows + index, shape.characters);
          payloadBytes += JSON.stringify(draft).length;
          drafts.push(draft);
        }
        const committed = yield* db.appendAll(drafts);
        if (committed.length !== drafts.length)
          throw new Error('partial commit in bytes tranche');
        rows += drafts.length;
        const live = databaseBytes(root);
        emit({
          scenario: 'bytes-written',
          shape: shape.name,
          phase: 'open',
          tranche: tranche + 1,
          rowsSoFar: rows,
          rowsThisTranche: drafts.length,
          payloadBytesSoFar: payloadBytes,
          ...live,
          liveBytesPerRow: (live.dbBytes + live.walBytes) / rows,
        });
      }
      return { rows, payloadBytes };
    });
    // Closing the connection is what checkpoints and truncates the WAL, so
    // the settled figure is the one a session root actually keeps on disk.
    const settled = databaseBytes(root);
    if (settled.walBytes > 0)
      throw new Error('WAL survived the close: ' + settled.walBytes + ' bytes');
    emit({
      scenario: 'bytes-written',
      shape: shape.name,
      phase: 'closed',
      rows: written.rows,
      payloadBytes: written.payloadBytes,
      ...settled,
      settledBytesPerRow: settled.dbBytes / written.rows,
      amplification: settled.dbBytes / written.payloadBytes,
    });
  }
}
`;

/** One scenario child. A non-zero exit is a failed measurement, never a gap. */
function measure(label, argv) {
  const result = spawnSync(process.execPath, ['--expose-gc', output, ...argv], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0)
    throw new Error(
      `${label} exited ${result.status ?? 'on ' + result.signal}`,
    );
}

const workspaces = [];
const workspace = () => {
  const directory = mkdtempSync(join(tmpdir(), 'texra-baseline-'));
  workspaces.push(directory);
  return directory;
};

/**
 * Timing scenarios are wall-clock measurements on a shared desktop, so a busy
 * machine does not produce a smaller number, it produces a meaningless one.
 * Refuse rather than record it; `--allow-load` is for an exploratory run whose
 * output is not going into a budget.
 */
const MAX_LOAD_AVERAGE = 8;
const allowLoad = process.argv.includes('--allow-load');
if (!allowLoad && os.loadavg()[0] > MAX_LOAD_AVERAGE) {
  console.error(
    `1-minute load average ${os.loadavg()[0].toFixed(2)} exceeds ${MAX_LOAD_AVERAGE}; ` +
      'wait for the machine to settle, or pass --allow-load for a throwaway run.',
  );
  process.exit(1);
}

try {
  mkdirSync(cache, { recursive: true });
  const bundle = await build({
    stdin: {
      contents: source,
      sourcefile: 'runtime-baseline.ts',
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
  writeFileSync(output, bundle.outputFiles[0].contents);

  console.log(
    JSON.stringify({
      scenario: 'environment',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      totalMemoryBytes: os.totalmem(),
      loadAverage1m: os.loadavg()[0],
      loadAverage5m: os.loadavg()[1],
      loadCeiling: allowLoad ? null : MAX_LOAD_AVERAGE,
      measuredAt: new Date().toISOString(),
    }),
  );

  // Short and long retained sessions, compared on the same interfaces.
  for (const [rows, characters] of [
    [1_000, 240],
    [100_000, 240],
  ]) {
    const storage = workspace();
    measure(`seed ${rows}`, [
      'seed',
      storage,
      String(rows),
      String(characters),
    ]);
    measure(`cold-open ${rows}`, ['open', storage, String(rows)]);
    measure(`replay ${rows}`, ['replay', storage, String(rows)]);
  }

  measure('loop-delay', ['loop', workspace(), '4', '5000']);
  measure('two-paper', [
    'twopaper',
    workspace(),
    workspace(),
    workspace(),
    '3000',
  ]);
  measure('bytes-written', ['bytes', workspace(), '5', '2000']);
} finally {
  rmSync(output, { force: true });
  for (const directory of workspaces)
    rmSync(directory, { recursive: true, force: true });
}
