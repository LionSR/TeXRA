// Suites for src/agent/trace emit helpers (stage metadata, tool-use cards,
// log-file categorization). RunTraceStream keeps its own suite.

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentEvent,
  type AgentTrace,
  emitToolUseCard,
  logFileCategory,
  RUN_FACT_EVENT_TYPES,
  type StageStartEvent,
  TraceEmitter,
} from '@agent/trace';
import { MESSAGE_TYPES } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';

// ---------------------------------------------------------------------------
// StageMetadata
// ---------------------------------------------------------------------------

describe('run-fact event vocabulary', () => {
  it('does not expose a mutable shared subscription list', () => {
    expect(Object.isFrozen(RUN_FACT_EVENT_TYPES)).toBe(true);
  });
});

describe('TraceEmitter stage metadata', () => {
  it('emits typed stage metadata for round stages', () => {
    const trace = new TraceEmitter();
    const starts: StageStartEvent[] = [];
    trace.subscribe((event) => {
      if (event.type === 'stage.start') starts.push(event);
    });

    const stage = trace.openStage('r1', {
      kind: 'round',
      index: 1,
      total: 3,
    });

    expect(starts).toEqual([
      expect.objectContaining({
        id: stage.id,
        label: 'r1',
        kind: 'round',
        index: 1,
        total: 3,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// responseFinalized (issue #7086)
// ---------------------------------------------------------------------------

describe('TraceEmitter responseFinalized', () => {
  it('emits a response.finalized event carrying the given text', () => {
    const trace = new TraceEmitter();
    const events: AgentEvent[] = [];
    trace.subscribe((event) => events.push(event));

    trace.responseFinalized('The answer is 2.');

    expect(events).toEqual([
      expect.objectContaining({
        type: 'response.finalized',
        text: 'The answer is 2.',
      }),
    ]);
  });

  it('stamps the ambient stage id when no explicit stageId is given', () => {
    const trace = new TraceEmitter();
    const events: AgentEvent[] = [];
    trace.subscribe((event) => events.push(event));

    const stage = trace.openStage('r0', { kind: 'round' });
    void stage.within(() => {
      trace.responseFinalized('Final answer.');
    });

    const finalized = events.find((e) => e.type === 'response.finalized');
    expect(finalized).toMatchObject({ stageId: stage.id });
  });
});

// ---------------------------------------------------------------------------
// EmitToolUseCard
// ---------------------------------------------------------------------------

type ToolUseCard = Parameters<typeof emitToolUseCard>[1];

/** Emit a card on a fresh trace and return only its tool.start/tool.end events. */
function collectToolEvents(card: ToolUseCard): AgentEvent[] {
  const trace = new TraceEmitter();
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));

  emitToolUseCard(trace, card);

  return events.filter((e) => e.type === 'tool.start' || e.type === 'tool.end');
}

describe('emitToolUseCard', () => {
  it('emits only tool.start when no status is passed (slow-tool path)', () => {
    const toolEvents = collectToolEvents({
      toolName: 'bash',
      input: { command: 'ls' },
    });

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });

  it('emits tool.start + tool.end when status is completed (fast-tool path)', () => {
    const toolEvents = collectToolEvents({
      toolName: 'todo_write',
      input: { items: [] },
      output: 'ok',
      isError: false,
      status: 'completed',
    });

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.type).toBe('tool.start');
    expect(toolEvents[1]?.type).toBe('tool.end');
    if (toolEvents[1]?.type === 'tool.end') {
      expect(toolEvents[1].status).toBe('completed');
      // start and end share the same logId so the transcript can match them
      const startLogId =
        toolEvents[0]?.type === 'tool.start' ? toolEvents[0].logId : null;
      expect(toolEvents[1].logId).toBe(startLogId);
    }
  });

  it('emits tool.start + tool.end when status is failed', () => {
    const toolEvents = collectToolEvents({
      toolName: 'bash',
      input: { command: 'false' },
      isError: true,
      status: 'failed',
    });

    expect(toolEvents).toHaveLength(2);
    if (toolEvents[1]?.type === 'tool.end') {
      expect(toolEvents[1].status).toBe('failed');
    }
  });

  it('does not emit tool.end when status is explicitly in_progress', () => {
    const toolEvents = collectToolEvents({
      toolName: 'bash',
      input: { command: 'sleep' },
      status: 'in_progress',
    });

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });
});

// ---------------------------------------------------------------------------
// logFileCategory
// ---------------------------------------------------------------------------

describe('logFileCategory', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let capturedMessages: any[];
  let store: StreamLogStore;

  beforeEach(async () => {
    store = StreamLogStore.ephemeral('test');
    await store.clear();
    const runTrace = createRunTrace('TestFileListLogger', store);
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
    capturedMessages = [];
  });

  afterEach(() => {
    // Release the run-trace subscribers so `activeFlushers` in runTrace.ts
    // doesn't accumulate dead closures across the suite.
    disposeTrace();
  });

  const refreshCaptured = (): void => {
    const log = store.get('TestFileListLogger');
    capturedMessages = (log?.getRange(0, log.head) ?? []).map((entry) => ({
      id: entry.id,
      text: entry.text ?? '',
      level: entry.level,
      timestamp: entry.timestamp,
      messageType: entry.messageType,
      data: entry.data,
    }));
  };

  it('handles empty file array gracefully (no-op)', () => {
    logFileCategory(logger, 'Input Files', []);
    refreshCaptured();
    assert.equal(capturedMessages.length, 0);
  });

  // Only files with `ok === true` count as loaded; missing/false/undefined
  // `ok` are excluded from the numerator of the "Loading X (n/m)" label.
  it.each<{
    label: string;
    files: { path: string; ok?: boolean }[];
    expected: string;
  }>([
    {
      label: 'Input Files',
      files: [{ path: '/path/to/file.tex', ok: true }],
      expected: 'Loading Input Files (1/1)',
    },
    {
      label: 'Reference Files',
      files: [
        { path: '/path/exists.tex', ok: true },
        { path: '/path/missing.tex', ok: false },
        { path: '/path/also-exists.tex', ok: true },
      ],
      expected: 'Loading Reference Files (2/3)',
    },
    {
      label: 'Auxiliary Files',
      files: [
        { path: '/path/exists.tex', ok: true },
        { path: '/path/unknown.tex' }, // ok is undefined → not loaded
      ],
      expected: 'Loading Auxiliary Files (1/2)',
    },
    {
      label: 'Media Files',
      files: [
        { path: '/path/missing1.png', ok: false },
        { path: '/path/missing2.png', ok: false },
      ],
      expected: 'Loading Media Files (0/2)',
    },
  ])('logs "$expected"', ({ label, files, expected }) => {
    logFileCategory(logger, label, files);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].messageType, MESSAGE_TYPES.FILE_LIST);
    assert.equal(capturedMessages[0].text, expected);
  });

  it('includes source and sourceDisplay in entry data', () => {
    logFileCategory(logger, 'Input Files', [
      { path: '/path/file.tex', ok: true },
    ]);

    refreshCaptured();
    const entries = capturedMessages[0].data;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'Input Files');
    assert.equal(entries[0].sourceDisplay, 'Input Files');
    assert.equal(entries[0].path, '/path/file.tex');
    assert.equal(entries[0].ok, true);
  });

  it('maps ok properly in entries (undefined becomes false)', () => {
    logFileCategory(logger, 'Test', [
      { path: '/a', ok: true },
      { path: '/b', ok: false },
      { path: '/c' }, // undefined
    ]);

    refreshCaptured();
    const entries = capturedMessages[0].data;
    assert.equal(entries[0].ok, true);
    assert.equal(entries[1].ok, false);
    assert.equal(entries[2].ok, false);
  });
});
