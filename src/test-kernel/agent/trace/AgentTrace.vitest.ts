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

/** Collect every event a fresh trace emits while `act` runs. */
function collectEvents(act: (trace: TraceEmitter) => void): AgentEvent[] {
  const trace = new TraceEmitter();
  const events: AgentEvent[] = [];
  trace.subscribe((event) => events.push(event));
  act(trace);
  return events;
}

describe('run-fact event vocabulary', () => {
  it('does not expose a mutable shared subscription list', () => {
    expect(Object.isFrozen(RUN_FACT_EVENT_TYPES)).toBe(true);
  });
});

describe('TraceEmitter stage metadata', () => {
  it('emits typed stage metadata for round stages', () => {
    let stageId: string | undefined;
    const starts = collectEvents((trace) => {
      stageId = trace.openStage('r1', {
        kind: 'round',
        index: 1,
        total: 3,
      }).id;
    }).filter(
      (event): event is StageStartEvent => event.type === 'stage.start',
    );

    expect(starts).toEqual([
      expect.objectContaining({
        id: stageId,
        label: 'r1',
        kind: 'round',
        index: 1,
        total: 3,
      }),
    ]);
  });
});

describe('TraceEmitter responseFinalized', () => {
  it('emits a response.finalized event carrying the given text', () => {
    const events = collectEvents((trace) => {
      trace.responseFinalized('The answer is 2.');
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'response.finalized',
        text: 'The answer is 2.',
      }),
    ]);
  });

  it('stamps the ambient stage id when no explicit stageId is given', () => {
    let stageId: string | undefined;
    const events = collectEvents((trace) => {
      const stage = trace.openStage('r0', { kind: 'round' });
      stageId = stage.id;
      void stage.within(() => {
        trace.responseFinalized('Final answer.');
      });
    });

    const finalized = events.find((e) => e.type === 'response.finalized');
    expect(finalized).toMatchObject({ stageId });
  });
});

type ToolUseCard = Parameters<typeof emitToolUseCard>[1];

/** Emit a card on a fresh trace and return only its tool.start/tool.end events. */
function collectToolEvents(card: ToolUseCard): AgentEvent[] {
  return collectEvents((trace) => emitToolUseCard(trace, card)).filter(
    (e) => e.type === 'tool.start' || e.type === 'tool.end',
  );
}

describe('emitToolUseCard', () => {
  it.each<{ name: string; card: ToolUseCard }>([
    {
      name: 'no status is passed (slow-tool path)',
      card: { toolName: 'bash', input: { command: 'ls' } },
    },
    {
      name: 'status is explicitly in_progress',
      card: {
        toolName: 'bash',
        input: { command: 'sleep' },
        status: 'in_progress',
      },
    },
  ])('emits only tool.start when $name', ({ card }) => {
    const toolEvents = collectToolEvents(card);

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.type).toBe('tool.start');
  });

  it.each<{ status: 'completed' | 'failed'; card: ToolUseCard }>([
    {
      status: 'completed',
      card: {
        toolName: 'todo_write',
        input: { items: [] },
        output: 'ok',
        isError: false,
        status: 'completed',
      },
    },
    {
      status: 'failed',
      card: {
        toolName: 'bash',
        input: { command: 'false' },
        isError: true,
        status: 'failed',
      },
    },
  ])(
    'emits tool.start + tool.end when status is $status (fast-tool path)',
    ({ status, card }) => {
      const toolEvents = collectToolEvents(card);

      expect(toolEvents).toHaveLength(2);
      const [start, end] = toolEvents;
      expect(start?.type).toBe('tool.start');
      expect(end?.type).toBe('tool.end');
      if (start?.type === 'tool.start' && end?.type === 'tool.end') {
        expect(end.status).toBe(status);
        // start and end share the same logId so the transcript can match them
        expect(end.logId).toBe(start.logId);
      }
    },
  );
});

describe('logFileCategory', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let store: StreamLogStore;

  beforeEach(async () => {
    store = StreamLogStore.ephemeral('test');
    await store.clear();
    const runTrace = createRunTrace('TestFileListLogger', store);
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
  });

  afterEach(() => {
    // Release the run-trace subscribers so `activeFlushers` in runTrace.ts
    // doesn't accumulate dead closures across the suite.
    disposeTrace();
  });

  function capturedMessages(): any[] {
    const log = store.get('TestFileListLogger');
    return log?.getRange(0, log.head) ?? [];
  }

  it('handles empty file array gracefully (no-op)', () => {
    logFileCategory(logger, 'Input Files', []);
    expect(capturedMessages()).toHaveLength(0);
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

    const messages = capturedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].messageType).toBe(MESSAGE_TYPES.FILE_LIST);
    expect(messages[0].text).toBe(expected);
  });

  it('includes source and sourceDisplay in entry data', () => {
    logFileCategory(logger, 'Input Files', [
      { path: '/path/file.tex', ok: true },
    ]);

    const entries = capturedMessages()[0].data;
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('Input Files');
    expect(entries[0].sourceDisplay).toBe('Input Files');
    expect(entries[0].path).toBe('/path/file.tex');
    expect(entries[0].ok).toBe(true);
  });

  it('maps ok properly in entries (undefined becomes false)', () => {
    logFileCategory(logger, 'Test', [
      { path: '/a', ok: true },
      { path: '/b', ok: false },
      { path: '/c' }, // undefined
    ]);

    const entries = capturedMessages()[0].data;
    expect(entries[0].ok).toBe(true);
    expect(entries[1].ok).toBe(false);
    expect(entries[2].ok).toBe(false);
  });
});
