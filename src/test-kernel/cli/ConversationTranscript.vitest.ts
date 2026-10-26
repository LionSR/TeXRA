// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';

import {
  incrementalStaticTranscriptEntries,
  orderedStaticTranscriptEntries,
} from '@cli/chat/tui/panes/transcriptEntries';
import {
  advanceStaticTranscriptState,
  buildStaticTranscriptItems,
  buildStaticTranscriptState,
  type StaticTranscriptItem,
  type StaticTranscriptRingBudgets,
} from '@cli/chat/tui/panes/staticTranscriptRing';
import { staticScrollbackTarget } from '@cli/chat/tui/appLayout';
import { staticTranscriptRepaintEpoch } from '@cli/chat/tui/state/staticTranscriptRepaint';
import { createTuiViewportController } from '@cli/chat/tui/render/tuiViewportController';
import { selectTranscriptEntriesForViewport } from '@cli/chat/tui/panes/transcriptViewport';
import {
  RUN_PHASE,
  TOOL_CALL_STATUS,
  type NormalizedToolUse,
  type RunPhase,
  type RunId,
} from '@shared/schemas';
import {
  isSettledRow,
  type ToolRow,
  type TranscriptRow,
} from '@shared/transcript/transcriptRow';
import {
  compactionRowFixture,
  splitTranscriptEntries,
  textRowFixture,
  toolRowFixture,
} from '@test/support/transcriptRowFixtures';

const ROOT_RUN = 'root-run' as RunId;
const CHILD_RUN = 'c41dc41dc41d' as RunId;
const SESSION_META = {
  agent: 'research',
  model: 'deepseek/deepseek-v4-flash',
  modelSource: 'builtin-default',
  cwd: '/tmp/project',
  apiMode: 'personal',
  approvalPolicy: 'ask',
  version: '0.38.0',
} as const;

// A row the CLI treats as settled on arrival carries the recorder's durable
// settlement order. Fixtures settle in the order they were built, so a row's
// own wire position doubles as its settlement position.
function settled<T extends TranscriptRow>(row: T): T {
  return { ...row, settlementSeqNo: row.seqNo ?? 0 };
}

// Fixtures are built in the order they appear in the transcript, so a shared
// counter gives every row a wire position and lets a settled row state a
// settlement order that agrees with it.
let fixtureSeq = 0;

function entry(
  id: string,
  kind: 'assistant' | 'error' | 'user',
  text: string,
  isSettled: boolean,
): TranscriptRow {
  const seqNo = (fixtureSeq += 1);
  const row = { ...textRowFixture(id, kind, text), seqNo };
  // user/error rows settle on their own kind; only prose needs a settlement
  // order to count as printable.
  return isSettled && kind === 'assistant' ? settled(row) : row;
}

function compactionEntry(
  status: 'running' | 'interrupted' | 'completed',
  finalized = status === 'completed',
): TranscriptRow {
  return compactionRowFixture(status, finalized);
}

function toolEntry(
  id: string,
  status: NormalizedToolUse['status'],
  outputText = status === 'completed' ? 'ok' : '',
  overrides: Partial<NormalizedToolUse> = {},
): ToolRow {
  return {
    ...toolRowFixture(id, {
      toolName: 'Bash',
      outputText,
      input: { command: 'ls' },
      status,
      ...overrides,
    }),
    seqNo: (fixtureSeq += 1),
  };
}

describe('CLI conversation transcript', () => {
  it('keeps only explicit finalized entries in scrollback', () => {
    const user = entry('u1', 'user', '1+1', true);
    const assistant = entry('a1', 'assistant', '2', false);

    const running = splitTranscriptEntries(
      [user, assistant],
      settledPrefix([user, assistant]),
      RUN_PHASE.RUNNING,
    );
    expect(running.finalized).toEqual([user]);
    expect(running.pending).toEqual([assistant]);

    const waitingBeforeFinalize = splitTranscriptEntries(
      [user, assistant],
      settledPrefix([user, assistant]),
      RUN_PHASE.WAITING,
    );
    expect(waitingBeforeFinalize.finalized).toEqual([user]);
    expect(waitingBeforeFinalize.pending).toEqual([]);
  });

  it('keeps finalized rows behind an unfinished assistant live in the pending pane', () => {
    const user = entry('u1', 'user', 'go', true);
    const assistant = entry('a1', 'assistant', 'working', false);
    const tool = {
      ...toolEntry('t1', TOOL_CALL_STATUS.COMPLETED),
      finalized: true,
    };

    const split = splitTranscriptEntries(
      [user, assistant, tool],
      settledPrefix([user, assistant, tool]),
      RUN_PHASE.RUNNING,
    );
    expect(split.finalized.map((item) => item.id)).toEqual(['u1']);
    expect(split.pending.map((item) => item.id)).toEqual(['a1', 't1']);
  });

  it('keeps running compaction live and promotes its terminal update once', () => {
    const running = compactionEntry('running');
    expect(
      splitTranscriptEntries(
        [running],
        settledPrefix([running]),
        RUN_PHASE.RUNNING,
      ).pending,
    ).toEqual([running]);
    expect(staticItemIds([running])).toEqual(['session-header']);

    const completed = compactionEntry('completed');
    expect(
      splitTranscriptEntries(
        [completed],
        settledPrefix([completed]),
        RUN_PHASE.RUNNING,
      ).finalized,
    ).toEqual([completed]);
    expect(staticItemIds([completed])).toEqual([
      'session-header',
      'compaction:operation-1',
    ]);
    expect(
      advancedItems(staticState([completed]), [completed]).map(
        (item) => item.id,
      ),
    ).toEqual(['session-header', 'compaction:operation-1']);
  });

  // Status facts reach the CLI through the session-signals adapter: the
  // status machine publishes on the session hub, and the adapter's status
  // modality patches the slice before syncing the log (forceFinal on
  // settlement phases).

  // Regression: a stream reused for a new run still carries WAITING from
  // the prior turn. The status must flip to a non-final value before
  // syncStreamLog derives finalizeDeferred, otherwise the next run's
  // in-flight entries get finalized early and lose later chunks.
  // One pending bucket in stream order: a model that emits prose before a
  // tool call must render as assistant text then tool row, not the reverse.
  // Regression: tool rows must not finalize on their own — the stream-
  // level finalizer is the single promotion edge. Otherwise a fast tool
  // call jumps into <Static> ahead of still-streaming assistant text
  // and the scrollback order ends up reversed.
  it('keeps a bounded tail when the newest live entry is taller than the viewport', () => {
    const assistant = entry(
      'a1',
      'assistant',
      Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
      false,
    );

    const selected = selectTranscriptEntriesForViewport([assistant], 4, 80);

    expect(selected.entries.map((item) => item.id)).toEqual(['a1']);
    expect(selected.usedRows).toBe(4);
    expect(selected.rowLimits.get('a1')).toBe(4);
  });

  it('appends only finalized entries to terminal scrollback items', () => {
    const user = entry('u1', 'user', 'What is a tensor network?', true);
    const assistant = entry('a1', 'assistant', 'A decomposition.', false);

    const first = staticState([user, assistant]);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.kind).toBe('header');
    expect(first.items.slice(1).map((item) => item.id)).toEqual(['u1']);

    const second = advancedItems(first, [user, settled(assistant)]);
    expect(second).toHaveLength(3);
    expect(second.slice(1).map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('bounds the static transcript ring by rows without trimming the header', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`e${index}`, 'assistant', 'x', true),
    );
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 12,
      rowLowWater: 8,
      byteHighWater: 1024 * 1024,
      byteLowWater: 1024 * 1024,
    };
    const built = buildStaticTranscriptItems({
      source: sourceOf(entries),
      meta: SESSION_META,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e16',
      'e17',
      'e18',
      'e19',
    ]);
    expect(built.totals.rows).toBeLessThanOrEqual(budgets.rowLowWater);
  });

  it('bounds the static transcript ring by bytes and drops oldest non-header items', () => {
    const entries = Array.from({ length: 3 }, (_, index) =>
      entry(`e${index}`, 'assistant', 'x'.repeat(80), true),
    );
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 10_000,
      rowLowWater: 10_000,
      byteHighWater: 160,
      byteLowWater: 64,
    };
    const built = buildStaticTranscriptItems({
      source: sourceOf(entries),
      meta: SESSION_META,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e2',
    ]);
  });

  it('keeps a single oversized finalized entry even when it exceeds the budget', () => {
    const oversized = entry('e0', 'assistant', 'x'.repeat(80), true);
    const budgets: StaticTranscriptRingBudgets = {
      rowHighWater: 2,
      rowLowWater: 1,
      byteHighWater: 10,
      byteLowWater: 5,
    };
    const built = buildStaticTranscriptItems({
      source: sourceOf([oversized]),
      meta: SESSION_META,
      width: 80,
      ringBudgets: budgets,
    });

    expect(built.items.map((item) => item.id)).toEqual([
      'session-header',
      'e0',
    ]);
    expect(built.trimmed).toBe(false);
  });

  it('keeps a finalized tool behind an unfinalized assistant out of the settled prefix', () => {
    const user = entry('u1', 'user', 'go', true);
    const assistant = entry('a1', 'assistant', 'working', false);
    const tool = {
      ...settled(toolEntry('t1', TOOL_CALL_STATUS.COMPLETED)),
    };
    const settledAssistant = settled(assistant);
    const emptyCursor = {
      entriesRef: undefined,
      scannedIndex: 0,
      lastScannedEntry: undefined,
      status: undefined,
      lastAppendedKey: undefined,
    } as const;

    expect(
      orderedStaticTranscriptEntries(
        [user, assistant, tool],
        settledPrefix([user, assistant, tool]),
        RUN_PHASE.RUNNING,
      ).map((item) => item.id),
    ).toEqual(['u1']);

    const first = incrementalStaticTranscriptEntries(
      [user, assistant, tool],
      settledPrefix([user, assistant, tool]),
      RUN_PHASE.RUNNING,
      emptyCursor,
    );
    expect(first.appended.map((item) => item.id)).toEqual(['u1']);
    expect(first.cursor.scannedIndex).toBe(1);

    const second = incrementalStaticTranscriptEntries(
      [user, settledAssistant, tool],
      settledPrefix([user, settledAssistant, tool]),
      RUN_PHASE.RUNNING,
      first.cursor,
    );
    expect(second.appended.map((item) => item.id)).toEqual(['a1', 't1']);
    expect(second.cursor.scannedIndex).toBe(3);
  });

  it('appends settled entries incrementally and resumes a deferred live prompt', () => {
    const user = entry('u1', 'user', 'what is this repo about', true);
    const assistantPending = entry('a1', 'assistant', 'working', false);
    const assistantSettled = settled(assistantPending);
    const emptyCursor = {
      entriesRef: undefined,
      scannedIndex: 0,
      lastScannedEntry: undefined,
      status: undefined,
      lastAppendedKey: undefined,
    } as const;

    const first = incrementalStaticTranscriptEntries(
      [user],
      settledPrefix([user]),
      RUN_PHASE.RUNNING,
      emptyCursor,
    );
    expect(first.appended).toEqual([]);
    expect(first.cursor.scannedIndex).toBe(0);

    const second = incrementalStaticTranscriptEntries(
      [user, assistantPending],
      settledPrefix([user, assistantPending]),
      RUN_PHASE.RUNNING,
      first.cursor,
    );
    expect(second.appended.map((item) => item.id)).toEqual(['u1']);
    expect(second.cursor.scannedIndex).toBe(1);

    const third = incrementalStaticTranscriptEntries(
      [user, assistantSettled],
      settledPrefix([user, assistantSettled]),
      RUN_PHASE.RUNNING,
      second.cursor,
    );
    expect(third.appended.map((item) => item.id)).toEqual(['a1']);
    expect(third.cursor.scannedIndex).toBe(2);
  });

  it('appends an incremental suffix in the same settlement order a repaint uses', () => {
    // Wire order is [t1, a1] but a1 settled first. The live path prints the
    // suffix once; a repaint rebuilds from `orderedStaticTranscriptEntries`,
    // so both must agree or rows swap places across the repaint.
    const rows = [
      { ...toolEntry('t1', TOOL_CALL_STATUS.COMPLETED), settlementSeqNo: 20 },
      { ...entry('a1', 'assistant', 'done', true), settlementSeqNo: 10 },
    ];
    const oracle = orderedStaticTranscriptEntries(
      rows,
      settledPrefix(rows),
      RUN_PHASE.RUNNING,
    ).map((row) => row.id);
    expect(oracle).toEqual(['a1', 't1']);

    const emptyCursor = {
      entriesRef: undefined,
      scannedIndex: 0,
      lastScannedEntry: undefined,
      status: undefined,
      lastAppendedKey: undefined,
    } as const;
    const live = incrementalStaticTranscriptEntries(
      rows,
      settledPrefix(rows),
      RUN_PHASE.RUNNING,
      emptyCursor,
    );
    expect(live.appended.map((row) => row.id)).toEqual(oracle);

    // The same swap across a tick boundary: A settles late (key 20) and is
    // printed while C still runs; then B (key 10) settles behind C. Sorting
    // the new suffix alone would print [A, B, C] where the oracle says
    // [B, A, C], so the scan must hand back to the oracle instead.
    const a = {
      ...toolEntry('a', TOOL_CALL_STATUS.COMPLETED),
      settlementSeqNo: 20,
    };
    const running = toolEntry('c', TOOL_CALL_STATUS.IN_PROGRESS);
    const c = {
      ...running,
      status: TOOL_CALL_STATUS.COMPLETED,
      settlementSeqNo: 30,
    };
    const b = {
      ...entry('b', 'assistant', 'files', true),
      settlementSeqNo: 10,
    };
    const tick1 = incrementalStaticTranscriptEntries(
      [a, running],
      settledPrefix([a, running]),
      RUN_PHASE.RUNNING,
      emptyCursor,
    );
    expect(tick1.appended.map((row) => row.id)).toEqual(['a']);
    const tick2 = incrementalStaticTranscriptEntries(
      [a, c, b],
      settledPrefix([a, c, b]),
      RUN_PHASE.RUNNING,
      tick1.cursor,
    );
    expect(tick2.rebuild).toBe(true);
    expect(tick2.appended).toEqual([]);
    expect(
      orderedStaticTranscriptEntries(
        [a, c, b],
        settledPrefix([a, c, b]),
        RUN_PHASE.RUNNING,
      ).map((row) => row.id),
    ).toEqual(['b', 'a', 'c']);
  });

  it('only feeds the root scrollback run, not background subagents', () => {
    const items = buildStaticTranscriptItems({
      source: rootChildSource(ROOT_RUN, 'do x', 'done'),
      meta: SESSION_META,
    }).items;

    expect(items.slice(1).map((item) => item.id)).toEqual(['u1']);
  });

  it('uses the focused child as the static scrollback owner in scoped view', () => {
    const scrollbackTarget = staticScrollbackTarget({
      activeRunId: CHILD_RUN,
      rootRunId: ROOT_RUN,
      scopedTranscript: true,
    });
    const items = buildStaticTranscriptItems({
      source: rootChildSource(
        scrollbackTarget.runId,
        'root prompt',
        'child detail',
      ),
      meta: SESSION_META,
    }).items;

    expect(scrollbackTarget).toEqual({
      ownerKey: `run:${CHILD_RUN}`,
      runId: CHILD_RUN,
    });
    expect(items.slice(1).map((item) => item.id)).toEqual(['a1']);
  });

  it('repaints static transcript invalidations from a clean origin', () => {
    const calls: unknown[] = [];
    const controller = createTuiViewportController({
      current: {
        repaint: (options) => {
          calls.push(options);
        },
      },
    });

    staticTranscriptRepaintEpoch.set(0);
    controller.repaintTranscript();
    controller.repaintAfterTerminalResume();

    expect(calls).toEqual([{ clearScrollback: true, preserveStatic: false }]);
    expect(staticTranscriptRepaintEpoch.get()).toBe(1);
  });
});

/** The fold's settled prefix for `entries`: the leading rows that settle
 *  on their own (5.2, `settledRows`). */
function settledPrefix(entries: readonly TranscriptRow[] | undefined): number {
  let count = 0;
  for (const row of entries ?? []) {
    if (!isSettledRow(row, false)) break;
    count += 1;
  }
  return count;
}

/** Static scrollback for `entries` of one stream, settled as far as the
 *  fold's prefix reaches. */
function sourceOf(
  entries: readonly TranscriptRow[] | undefined,
  status?: RunPhase,
): StaticScrollbackSource {
  return {
    entries,
    settledRows: settledPrefix(entries),
    status,
    waitingForChildIdentity: false,
    child: undefined,
    hardReset: false,
  };
}
/** The scrollback owner's rows out of a root with one user entry and a
 *  background child with one assistant entry. */
function rootChildSource(
  scrollbackRunId: RunId | undefined,
  rootText: string,
  childText: string,
): StaticScrollbackSource {
  if (scrollbackRunId === ROOT_RUN) {
    return sourceOf([entry('u1', 'user', rootText, true)]);
  }
  if (scrollbackRunId === CHILD_RUN) {
    return sourceOf([entry('a1', 'assistant', childText, true)]);
  }
  return sourceOf(undefined);
}
/** Static scrollback for a single-run transcript of `entries`. */
function staticItems(
  entries: readonly TranscriptRow[],
  options: {
    readonly maxRows?: number;
    readonly width?: number;
  } = {},
): readonly StaticTranscriptItem[] {
  return buildStaticTranscriptItems({
    maxRows: options.maxRows,
    meta: SESSION_META,
    source: sourceOf(entries),
    width: options.width,
  }).items;
}
type StaticState = ReturnType<typeof buildStaticTranscriptState>;
type StaticScrollbackSource = Parameters<
  typeof buildStaticTranscriptItems
>[0]['source'];
/** The live transcript state after a cold build over `entries`. */
function staticState(
  entries: readonly TranscriptRow[],
  options: { readonly maxRows?: number; readonly width?: number } = {},
): StaticState {
  return buildStaticTranscriptState({
    maxRows: options.maxRows,
    meta: SESSION_META,
    ownerKey: 'static-test',
    repaintEpoch: 0,
    source: sourceOf(entries),
    width: options.width ?? 80,
  });
}
/** Items after one ordinary stream-sync tick from `state` to `entries`. */
function advancedItems(
  state: StaticState,
  entries: readonly TranscriptRow[],
  options: { readonly maxRows?: number; readonly width?: number } = {},
): readonly StaticTranscriptItem[] {
  return advanceStaticTranscriptState(state, {
    maxRows: options.maxRows,
    meta: SESSION_META,
    ownerKey: state.ownerKey,
    source: sourceOf(entries),
    width: options.width ?? 80,
  }).items;
}
function staticItemIds(
  entries: readonly TranscriptRow[],
  options: Parameters<typeof staticItems>[1] = {},
): readonly string[] {
  return staticItems(entries, options).map((item) => item.id);
}
