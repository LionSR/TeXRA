/**
 * D5 measurement (issue #11864; PR #11893, "Proposed amendment and decision
 * gate"): can the session fold publish immutable views with structural
 * sharing, within the 16 ms frame budget and within 2x of today's cold
 * replay, instead of the in-place level it publishes now?
 *
 * Skipped unless `TEXRA_FOLD_BENCH=1`; never part of `npm test` or CI. The
 * production fold is not changed. Two variants are built here, in this file
 * only, by transforming `sessionFold.ts` at its exact in-place write sites
 * and bundling the result beside an untransformed bundle of the same source:
 *
 * - `copy-on-touch`: each frame produces a new `SessionView`; a session Map
 *   the frame writes and the row and task-group arrays of a transcript the
 *   frame touches are copied once per frame (`new Map(old)`, `old.slice()`);
 *   untouched branches are shared by reference.
 * - `bucketed`: the same, but the six session Maps are 64-bucket persistent
 *   maps, so a write copies a 64-entry spine and one bucket rather than the
 *   whole Map. Transcript arrays are still sliced.
 *
 * Reproduce (from the repository root, other builds paused):
 *
 *   TEXRA_FOLD_BENCH=1 npx vitest run --config vitest.config.mjs \
 *     src/test-kernel/shared/session/foldPublication.bench.vitest.ts
 *
 * `TEXRA_FOLD_BENCH_OUT=/path/report.json` also writes the raw numbers.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type FoldInput,
  type StreamTabId,
} from '@shared/schemas';
import { fold as sourceFold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
} from '@shared/session/sessionView';

import {
  Log,
  OWNER,
  ROOT_POLICY,
  local,
  subscribe,
  tail,
} from './fanOutScenario';

const ENABLED = process.env.TEXRA_FOLD_BENCH === '1';
const FRAME_MS = 16;
const REPLAY_FRAME_INPUTS = 512;
const COLD_REPLAYS = 5;
const RETAINED_LEVELS = [10, 100] as const;
const MIB = 1024 ** 2;
const KIB = 1024;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const foldPath = join(repoRoot, 'src/shared/session/sessionFold.ts');

type Fold = (
  view: SessionView,
  input: FoldInput | readonly FoldInput[],
) => SessionView;

interface Variant {
  readonly name: 'current' | 'copy-on-touch' | 'bucketed';
  readonly fold: Fold;
}

// ---------------------------------------------------------------------------
// Variants: the production source with its in-place writes redirected
// ---------------------------------------------------------------------------

function replaceOnce(source: string, before: string, after: string): string {
  const parts = source.split(before);
  if (parts.length !== 2) {
    throw new Error(`expected exactly one occurrence of ${before}`);
  }
  return parts.join(after);
}

/** Every in-place write the fold makes to a value hosts can hold. */
const MAP_WRITE =
  /view\.(streams|policy|folded|latest|inflight|queuedFollowUps)\.(set|delete)\(/g;
const MAP_WRITE_SITES = 17;
const REPLACE_TRANSCRIPT_BODY = `  const next: TranscriptView = { ...transcript, ...patch };
  INDEXES.set(next, indexesOf(transcript));
  return next;`;

/** Shared by both variants: per-frame ownership so a container is copied at
 *  most once per published level and never after it was published. */
const OWNERSHIP = `
let owned = new WeakSet();
function writableArray(array) {
  if (owned.has(array)) return array;
  const copy = array.slice();
  owned.add(copy);
  return copy;
}
function writableMap(view, key) {
  const current = view[key];
  if (owned.has(current)) return current;
  const indexes = key === 'streams' ? sessionIndexesOf(view) : null;
  const copy = copyMap(current);
  if (indexes) SESSION_INDEXES.set(copy, indexes);
  owned.add(copy);
  view[key] = copy;
  return copy;
}
export function fold(view, input) {
  owned = new WeakSet();
  return mutableFold(view, input);
}
`;

const FULL_COPY = `function copyMap(map) { return new Map(map); }`;

/** A 64-bucket persistent map: a write copies the spine and one bucket. */
const BUCKETED_COPY = `
const BUCKETS = 64;
function bucketOf(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h % BUCKETS;
}
class BucketedMap {
  constructor(buckets, size) {
    this.buckets = buckets;
    this.size = size;
  }
  static from(map) {
    if (map instanceof BucketedMap) return new BucketedMap(map.buckets.slice(), map.size);
    const buckets = Array.from({ length: BUCKETS }, () => new Map());
    for (const [k, v] of map) buckets[bucketOf(k)].set(k, v);
    return new BucketedMap(buckets, map.size);
  }
  get(k) { return this.buckets[bucketOf(k)].get(k); }
  has(k) { return this.buckets[bucketOf(k)].has(k); }
  writable(i) {
    let b = this.buckets[i];
    if (!owned.has(b)) {
      b = new Map(b);
      owned.add(b);
      this.buckets[i] = b;
    }
    return b;
  }
  set(k, v) {
    const b = this.writable(bucketOf(k));
    if (!b.has(k)) this.size += 1;
    b.set(k, v);
    return this;
  }
  delete(k) {
    const i = bucketOf(k);
    if (!this.buckets[i].has(k)) return false;
    this.writable(i).delete(k);
    this.size -= 1;
    return true;
  }
  *keys() { for (const b of this.buckets) yield* b.keys(); }
  *values() { for (const b of this.buckets) yield* b.values(); }
  *entries() { for (const b of this.buckets) yield* b.entries(); }
  [Symbol.iterator]() { return this.entries(); }
}
function copyMap(map) { return BucketedMap.from(map); }
`;

function transformed(source: string, mapCopy: string): string {
  let next = replaceOnce(
    source,
    'export function fold(',
    'function mutableFold(',
  );
  const sites = [...next.matchAll(MAP_WRITE)].length;
  if (sites !== MAP_WRITE_SITES) {
    throw new Error(
      `sessionFold.ts has ${sites} in-place Map writes, expected ${MAP_WRITE_SITES}; update the transform`,
    );
  }
  next = next.replaceAll(MAP_WRITE, "writableMap(view, '$1').$2(");
  next = replaceOnce(
    next,
    REPLACE_TRANSCRIPT_BODY,
    `  const next: TranscriptView = { ...transcript, ...patch };
  next.rows = writableArray(next.rows);
  next.taskGroups = writableArray(next.taskGroups);
  INDEXES.set(next, indexesOf(transcript));
  return next;`,
  );
  return `${next}\n${mapCopy}\n${OWNERSHIP}`;
}

async function bundle(name: Variant['name']): Promise<Fold> {
  const outDir = join(repoRoot, 'node_modules/.cache/texra-fold-bench');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `${name}.mjs`);
  const mapCopy = name === 'bucketed' ? BUCKETED_COPY : FULL_COPY;
  await build({
    stdin: {
      contents: `export { fold } from '@shared/session/sessionFold';`,
      resolveDir: repoRoot,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    tsconfig: join(repoRoot, 'tsconfig.json'),
    logLevel: 'silent',
    plugins:
      name === 'current'
        ? []
        : [
            {
              name: 'fold-variant',
              setup(builder) {
                builder.onLoad(
                  { filter: /[/\\]sessionFold\.ts$/ },
                  async () => {
                    const { readFile } = await import('node:fs/promises');
                    return {
                      contents: transformed(
                        await readFile(foldPath, 'utf8'),
                        mapCopy,
                      ),
                      loader: 'ts',
                      resolveDir: dirname(foldPath),
                    };
                  },
                );
              },
            },
          ],
  });
  const module = (await import(pathToFileURL(outfile).href)) as {
    fold: Fold;
  };
  return module.fold;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedShape {
  /** Workflow roots, each with `childrenPerParent` agent children. */
  readonly parents: number;
  readonly childrenPerParent: number;
  /** Top-level agent runs with no children. */
  readonly plain: number;
  /** Settled rows per agent run (one user message, the rest replies). */
  readonly rowsPerAgent: number;
  /** Agent runs left running with a live reply row that the frames extend. */
  readonly streaming: number;
}

interface Seed {
  readonly inputs: readonly FoldInput[];
  readonly streaming: readonly StreamTabId[];
  readonly streams: number;
}

const hex12 = (n: number): string => n.toString(16).padStart(12, '0');
const idOf = (name: string, n: number): StreamTabId =>
  `${name}#${hex12(n)}` as StreamTabId;

/**
 * A long session: every agent run has a user message and settled replies;
 * workflow roots carry a plan, one phase, and a card per child that moves
 * planned, running, completed. All but the streaming runs have ended. Events
 * are emitted per stream in commit order, the way a publisher writes them.
 */
function buildSeed(shape: SeedShape): Seed {
  const log = new Log();
  let serial = 0;
  let at = 1_000_000;
  const streaming: StreamTabId[] = [];
  const all: StreamTabId[] = [];
  // Streaming runs are the first child of each of the last roots, then the
  // last plain runs; an open root's board reads a live child.
  const streamingRoots = Math.min(shape.parents, shape.streaming);
  const streamingPlain = Math.min(
    shape.plain,
    shape.streaming - streamingRoots,
  );

  const agent = (
    id: StreamTabId,
    parent: StreamTabId | null,
    live: boolean,
  ): void => {
    serial += 1;
    at += 1_000;
    all.push(id);
    const executionId = hex12(serial);
    log.emit(id, at, {
      type: 'run.start',
      executionId,
      identity: { kind: 'agent', agent: `custom:${id.split('#')[0]}` },
      category: AgentCategory.ToolUse,
      isRemote: false,
      userFollowUpSupport: 'unsupported',
      ...(parent ? { parentStreamId: parent } : {}),
    });
    log.emit(id, at, {
      type: 'run.config',
      executionId,
      config: { model: 'claude-sonnet-4-5', instruction: `work on ${id}` },
    });
    log.emit(id, at, {
      type: 'status',
      phase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
      runStartedAt: at,
    });
    log.entry(id, at + 1, {
      id: 'user-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.USER_MESSAGE,
      text: `Prove the lemma for ${id}.`,
    });
    for (let row = 1; row < shape.rowsPerAgent; row += 1) {
      log.entry(id, at + 1 + row, {
        id: `reply-${row}`,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        text: `Step ${row}: let x be a point of the domain and apply the bound.\nThen the claim follows.`,
        data: { status: 'completed' },
      });
    }
    const settled = at + shape.rowsPerAgent + 2;
    log.emit(id, settled, {
      type: 'conversation.progress',
      progress: { toolCallCount: shape.rowsPerAgent },
    });
    log.emit(id, settled, {
      type: 'usage',
      storageKey: executionId,
      usage: { inputTokens: 12_000, outputTokens: 900, cost: 0.04 },
    });
    if (live) {
      streaming.push(id);
      log.entry(id, settled + 1, {
        id: 'live',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        text: 'a',
        data: { status: 'running' },
      });
      return;
    }
    log.emit(id, settled + 1, {
      type: 'result',
      outcome: 'completed',
      executionId,
      category: AgentCategory.ToolUse,
      isSubagent: parent !== null,
    });
    log.emit(id, settled + 1, {
      type: 'status',
      phase: STREAM_PHASE.COMPLETED,
      previousPhase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });
  };

  const card = (
    root: StreamTabId,
    child: StreamTabId,
    status: 'planned' | 'running' | 'completed',
    when: number,
  ): void => {
    const name = child.split('#')[0];
    log.entry(root, when, {
      id: `call-${name}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.WORKFLOW_TASK,
      groupId: 'phase-Map',
      data: {
        id: name,
        label: name,
        phase: 'Map',
        attemptId: 'attempt-1',
        ...(status === 'planned' ? {} : { childStreamId: child }),
        status,
      },
    });
  };

  for (let p = 0; p < shape.parents; p += 1) {
    const root = idOf(`wf-${p}`, p);
    const children = Array.from({ length: shape.childrenPerParent }, (_, k) =>
      idOf(`agent-${p}-${k}`, shape.parents + p * shape.childrenPerParent + k),
    );
    const open = p >= shape.parents - streamingRoots;
    serial += 1;
    at += 1_000;
    all.push(root);
    const executionId = hex12(serial);
    log.emit(root, at, {
      type: 'run.start',
      executionId,
      identity: { kind: 'multiAgentWorkflow', workflowName: 'review' },
      category: AgentCategory.Workflow,
      isRemote: false,
      worktree: { workingDirectory: '/paper', branch: 'main' },
      userFollowUpSupport: 'unsupported',
      approvalPolicy: ROOT_POLICY,
      checkpointId: `review@${p}`,
    });
    log.emit(root, at, {
      type: 'run.config',
      executionId,
      config: {
        model: 'claude-sonnet-4-5',
        instruction: 'review the draft',
        agent: 'review',
        inputFiles: ['draft.tex'],
      },
    });
    log.emit(root, at, {
      type: 'status',
      phase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
      runStartedAt: at,
    });
    log.entry(root, at + 1, {
      id: 'plan',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      messageType: MESSAGE_TYPES.INTERNAL,
      text: '',
      data: {
        kind: 'workflowPlan',
        attemptId: 'attempt-1',
        phases: [{ title: 'Map' }],
        tasks: children.map((child) => {
          const name = child.split('#')[0];
          return { id: name, label: name, phase: 'Map' };
        }),
      },
    });
    log.entry(root, at + 2, {
      id: 'phase-Map',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      text: 'Map',
      data: { kind: 'phase', index: 0, total: 1, attemptId: 'attempt-1' },
    });
    log.emit(root, at + 2, {
      type: 'stage.start',
      id: 'phase-Map',
      label: 'Map',
      kind: 'phase',
      index: 0,
      total: 1,
    });
    for (const child of children) card(root, child, 'planned', at + 3);
    for (const [k, child] of children.entries()) {
      const live = open && k === 0;
      card(root, child, 'running', at + 4 + k);
      agent(child, root, live);
      if (!live) card(root, child, 'completed', at + 5 + k);
    }
    if (open) continue;
    at += 100;
    log.entry(root, at, {
      id: 'phase-Map',
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      text: 'Map',
      data: { kind: 'phase', status: 'completed', endTime: at },
    });
    log.emit(root, at, {
      type: 'result',
      outcome: 'completed',
      executionId,
      category: AgentCategory.Workflow,
      isSubagent: false,
    });
    log.emit(root, at, {
      type: 'status',
      phase: STREAM_PHASE.COMPLETED,
      previousPhase: STREAM_PHASE.RUNNING,
      cause: 'lifecycle',
    });
  }
  for (let n = 0; n < shape.plain; n += 1) {
    agent(
      idOf(`plain-${n}`, 1_000_000 + n),
      null,
      n >= shape.plain - streamingPlain,
    );
  }

  return {
    inputs: [
      subscribe(...all),
      ...log.events.map(tail),
      local({ self: [OWNER] }),
    ],
    streaming,
    streams: all.length,
  };
}

/** One 16 ms frame: one merged text append per streaming row. */
function frame(streaming: readonly StreamTabId[], index: number): FoldInput[] {
  const width = 40;
  const body = 'token '.repeat(7).slice(0, width - 1);
  const text = `${body}${index % 7 === 0 ? '\n' : ' '}`;
  return streaming.map((streamId) => ({
    _tag: 'chunk',
    streamId,
    rowId: 'live',
    from: 1 + index * width,
    to: 1 + (index + 1) * width,
    text,
  }));
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Distribution {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly over16ms: number;
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return {
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1)!,
    over16ms: values.filter((v) => v > FRAME_MS).length,
  };
}

let exposedGc: (() => void) | undefined;
function gc(): void {
  if (!exposedGc) {
    setFlagsFromString('--expose-gc');
    exposedGc = runInNewContext('gc') as () => void;
  }
  exposedGc();
}

function heapUsedAfterGc(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function yesNo(value: boolean | null): string {
  if (value === null) return 'n/a';
  return value ? 'yes' : 'no';
}

/** Deterministic digest of a view, whatever shape its maps take. */
function digest(view: SessionView): string {
  const json = JSON.stringify(view, (_key, value: unknown) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { entries?: unknown }).entries === 'function' &&
      typeof (value as { get?: unknown }).get === 'function'
    ) {
      return [...(value as Map<string, unknown>).entries()].sort(([a], [b]) =>
        compareKeys(a, b),
      );
    }
    return value;
  });
  return createHash('sha256').update(json).digest('hex');
}

function liveText(view: SessionView, id: StreamTabId): string {
  const row = view.streams.get(id)?.transcript.rows.at(-1);
  return row?.kind === 'assistant' ? row.text.full : '';
}

interface Result {
  readonly variant: Variant['name'];
  readonly rows: number;
  readonly inputs: number;
  readonly frames: number;
  readonly coldReplayMs: number;
  readonly coldReplayMaxFrameMs: number;
  readonly coldReplayOneBatchMs: number;
  readonly frameMs: Distribution;
  readonly allocatedPerFrameKiB: number | null;
  readonly retainedMiB: Record<number, number>;
  readonly olderLevelStable: boolean;
  readonly untouchedStreamShared: boolean | null;
  readonly finalDigest: string;
}

async function measure(
  variant: Variant,
  seed: Seed,
  frames: number,
): Promise<Result> {
  const { fold } = variant;
  const replayFrames = chunked(seed.inputs, REPLAY_FRAME_INPUTS);
  const replay = (): { view: SessionView; total: number; maxFrame: number } => {
    let view = emptySessionView('bench');
    let maxFrame = 0;
    const started = performance.now();
    for (const batch of replayFrames) {
      const before = performance.now();
      view = fold(view, batch);
      maxFrame = Math.max(maxFrame, performance.now() - before);
    }
    return { view, total: performance.now() - started, maxFrame };
  };

  // Cold replay in frames of 512: one warm-up, then the median of five.
  replay();
  const cold: number[] = [];
  const coldMax: number[] = [];
  let view = emptySessionView('bench');
  for (let i = 0; i < COLD_REPLAYS; i += 1) {
    gc();
    const run = replay();
    cold.push(run.total);
    coldMax.push(run.maxFrame);
    view = run.view;
  }
  // The same replay folded as one batch, the way the fold fiber receives a
  // completed replay (PRD 7.2): one publication instead of one per frame.
  const whole: number[] = [];
  for (let i = 0; i < COLD_REPLAYS; i += 1) {
    gc();
    const before = performance.now();
    fold(emptySessionView('bench'), seed.inputs);
    whole.push(performance.now() - before);
  }
  const rows = [...view.streams.values()].reduce(
    (sum, stream) => sum + stream.transcript.rows.length,
    0,
  );
  const inputs = Array.from({ length: frames }, (_, i) =>
    frame(seed.streaming, i),
  );

  // Sustained streaming, paced at 16 ms; only the fold call is timed.
  const level0 = view;
  const level0Text = seed.streaming.map((id) => liveText(level0, id));
  const untouched = level0.order.find((id) => !seed.streaming.includes(id));
  const untouchedBefore =
    untouched === undefined ? undefined : level0.streams.get(untouched);
  const elapsed: number[] = [];
  gc();
  const started = performance.now();
  for (const [i, input] of inputs.entries()) {
    const due = started + i * FRAME_MS;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    const before = performance.now();
    view = fold(view, input);
    elapsed.push(performance.now() - before);
  }
  const olderLevelStable = seed.streaming.every(
    (id, i) => liveText(level0, id) === level0Text[i],
  );
  const untouchedStreamShared =
    untouched === undefined
      ? null
      : view.streams.get(untouched) === untouchedBefore;
  const finalDigest = digest(view);

  // Allocation per frame: a separate, unpaced pass under the sampling heap
  // profiler, so the profiler cannot touch the timing above.
  let allocatedPerFrameKiB: number | null = null;
  let sampled = replay().view;
  try {
    gc();
    const inspector = new Session();
    inspector.connect();
    await inspector.post('HeapProfiler.startSampling', {
      samplingInterval: 32 * KIB,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (const input of inputs) sampled = fold(sampled, input);
    const { profile } = await inspector.post('HeapProfiler.stopSampling');
    inspector.disconnect();
    const total = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((sum, c) => sum + total(c), 0);
    allocatedPerFrameKiB = total(profile.head) / frames / KIB;
  } catch {
    // The inspector is unavailable in some worker pools; the column reads n/a.
    allocatedPerFrameKiB = null;
  }
  expect(digest(sampled)).toBe(finalDigest);

  // Retained heap when a reader holds the last N published levels: the
  // difference between holding N levels and holding the latest only.
  const retainedMiB: Record<number, number> = {};
  for (const count of RETAINED_LEVELS) {
    let held: SessionView[] = [];
    let latest = replay().view;
    for (const input of inputs) {
      latest = fold(latest, input);
      held.push(latest);
      if (held.length > count) held.shift();
    }
    const withLevels = heapUsedAfterGc();
    held = [latest];
    const latestOnly = heapUsedAfterGc();
    retainedMiB[count] = (withLevels - latestOnly) / MIB;
    expect(held[0]).toBe(latest);
  }

  return {
    variant: variant.name,
    rows,
    inputs: seed.inputs.length,
    frames,
    coldReplayMs: distribution(cold).p50,
    coldReplayMaxFrameMs: distribution(coldMax).p50,
    coldReplayOneBatchMs: distribution(whole).p50,
    frameMs: distribution(elapsed),
    allocatedPerFrameKiB,
    retainedMiB,
    olderLevelStable,
    untouchedStreamShared,
    finalDigest,
  };
}

const ms = (n: number): string => n.toFixed(2);

function table(title: string, results: readonly Result[]): string {
  const header = ['Metric', ...results.map((r) => r.variant)];
  const lines: string[][] = [
    [
      'Cold replay, frames of 512 (median of 5)',
      ...results.map((r) => `${ms(r.coldReplayMs)} ms`),
    ],
    [
      'Cold replay, slowest frame',
      ...results.map((r) => `${ms(r.coldReplayMaxFrameMs)} ms`),
    ],
    [
      'Cold replay, one batch (median of 5)',
      ...results.map((r) => `${ms(r.coldReplayOneBatchMs)} ms`),
    ],
    [
      'Streaming fold per frame p50',
      ...results.map((r) => `${ms(r.frameMs.p50)} ms`),
    ],
    [
      'Streaming fold per frame p95',
      ...results.map((r) => `${ms(r.frameMs.p95)} ms`),
    ],
    [
      'Streaming fold per frame max',
      ...results.map((r) => `${ms(r.frameMs.max)} ms`),
    ],
    ['Frames over 16 ms', ...results.map((r) => `${r.frameMs.over16ms}`)],
    [
      'Heap allocated per frame (sampled)',
      ...results.map((r) =>
        r.allocatedPerFrameKiB === null
          ? 'n/a'
          : `${r.allocatedPerFrameKiB.toFixed(0)} KiB`,
      ),
    ],
    ...RETAINED_LEVELS.map((count) => [
      `Retained by the last ${count} levels`,
      ...results.map((r) => `${r.retainedMiB[count].toFixed(2)} MiB`),
    ]),
    [
      'Older level unchanged after 400 frames',
      ...results.map((r) => yesNo(r.olderLevelStable)),
    ],
    [
      'Untouched stream shared by reference',
      ...results.map((r) => yesNo(r.untouchedStreamShared)),
    ],
  ];
  const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [
    `### ${title}`,
    '',
    row(header),
    row(header.map(() => '---')),
    ...lines.map(row),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

const WORKLOADS = {
  /** The D5 seed: about 3,000 streams, 300 of them roots with children,
   *  about 40,000 rows, five streams streaming. */
  session: {
    parents: 300,
    childrenPerParent: 3,
    plain: 1_800,
    rowsPerAgent: 14,
    streaming: 5,
  },
  /** One transcript of 40,000 rows, streaming alone: the array-copy cost
   *  the bucketed maps do not address. */
  longTranscript: {
    parents: 0,
    childrenPerParent: 0,
    plain: 1,
    rowsPerAgent: 40_000,
    streaming: 1,
  },
} satisfies Record<string, SeedShape>;

const STREAM_FRAMES = 400; // 2,000 chunks over 5 streams at 16 ms

describe.skipIf(!ENABLED)('fold publication (D5 measurement)', () => {
  it('measures the in-place fold against copy-on-touch and bucketed variants', async () => {
    const variants: Variant[] = [];
    for (const name of ['current', 'copy-on-touch', 'bucketed'] as const) {
      variants.push({ name, fold: await bundle(name) });
    }
    // The untransformed bundle must fold exactly what the source does.
    const parity = buildSeed({ ...WORKLOADS.session, plain: 20, parents: 4 });
    const parityFrames = Array.from({ length: 8 }, (_, i) =>
      frame(parity.streaming, i),
    );
    const expected = digest(
      parityFrames.reduce(
        sourceFold,
        sourceFold(emptySessionView('bench'), parity.inputs),
      ),
    );
    for (const variant of variants) {
      const view = parityFrames.reduce(
        variant.fold,
        variant.fold(emptySessionView('bench'), parity.inputs),
      );
      expect(digest(view), variant.name).toBe(expected);
    }

    const report: Record<string, Result[]> = {};
    const sections: string[] = [];
    for (const [name, shape] of Object.entries(WORKLOADS)) {
      const seed = buildSeed(shape);
      const results: Result[] = [];
      for (const variant of variants) {
        results.push(await measure(variant, seed, STREAM_FRAMES));
      }
      const digests = new Set(results.map((r) => r.finalDigest));
      expect(digests.size, `${name}: variants diverged`).toBe(1);
      report[name] = results;
      sections.push(
        table(
          `${name}: ${seed.streams} streams, ${results[0].rows} rows, ${results[0].inputs} replay inputs, ${seed.streaming.length} streaming, ${STREAM_FRAMES} frames`,
          results,
        ),
      );
    }
    const machine = `Node ${process.version}, ${process.platform} ${process.arch}, ${cpus()[0]?.model ?? 'unknown cpu'}, ${cpus().length} cores, ${(totalmem() / 1024 ** 3).toFixed(0)} GiB`;
    const out = [`Machine: ${machine}`, '', ...sections].join('\n\n');
    process.stdout.write(`\n${out}\n\n`);
    if (process.env.TEXRA_FOLD_BENCH_OUT) {
      writeFileSync(
        process.env.TEXRA_FOLD_BENCH_OUT,
        JSON.stringify({ machine, report }, null, 2),
      );
    }
  }, 600_000);
});
