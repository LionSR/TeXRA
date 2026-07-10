// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { isCliPipeClosureError, NdjsonStdoutSink } from '@cli/runtime/logSinks';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';

function createStdoutStub(writeResults: boolean[] = [true]) {
  const lines: string[] = [];
  const listeners = new Map<string, () => void>();
  return {
    lines,
    emit(event: 'drain' | 'error' | 'close') {
      listeners.get(event)?.();
    },
    stdout: {
      destroyed: false,
      write: vi.fn((line: string) => {
        lines.push(line);
        return writeResults.shift() ?? true;
      }),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string, listener: () => void) => {
        if (listeners.get(event) === listener) listeners.delete(event);
      }),
    },
  };
}

describe('NdjsonStdoutSink', () => {
  it('flushes consecutive synchronous writes without stranding the queue', async () => {
    const { lines, stdout } = createStdoutStub();
    const sink = new NdjsonStdoutSink(stdout);
    const records: readonly CliNdjsonRecord[] = [
      { kind: 'version', version: '1.0.0' },
      { kind: 'doctor-summary', ok: true },
    ];

    sink.writeRecord(records[0]);
    sink.writeRecord(records[1]);
    await sink.flush();

    expect(lines.map((line) => JSON.parse(line))).toEqual(records);
  });

  it('preserves order across logger and public-record writes', async () => {
    const { emit, lines, stdout } = createStdoutStub([false, true]);
    const sink = new NdjsonStdoutSink(stdout);

    sink.write({
      ts: '2026-07-10T00:00:00.000Z',
      level: 'error',
      message: 'first',
      fields: {},
    });
    sink.writeRecord({
      kind: 'progress',
      event: 'updateStreamStatus',
      payload: { streamId: 'stream-1', status: 'working' },
    });
    emit('drain');
    await sink.flush();

    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      'log',
      'progress',
    ]);
  });

  it('preserves records added while stdout is backpressured', async () => {
    const { emit, lines, stdout } = createStdoutStub([false, true]);
    const sink = new NdjsonStdoutSink(stdout);

    sink.writeRecord({ kind: 'version', version: '1.0.0' });
    sink.writeRecord({ kind: 'doctor-summary', ok: true });
    emit('drain');
    await sink.flush();

    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      'version',
      'doctor-summary',
    ]);
  });

  it.each(['error', 'close'] as const)(
    'discards queued and later records after stdout %s',
    async (event) => {
      const { emit, lines, stdout } = createStdoutStub([false]);
      const sink = new NdjsonStdoutSink(stdout);

      sink.writeRecord({ kind: 'version', version: '1.0.0' });
      sink.writeRecord({ kind: 'doctor-summary', ok: true });
      emit(event);
      sink.writeRecord({ kind: 'auth-status', authenticated: false });
      await sink.flush();

      expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['version']);
    },
  );
});

describe('CLI pipe errors', () => {
  it('recognizes pipe closure errors as non-fatal output events', () => {
    expect(
      isCliPipeClosureError(
        Object.assign(new Error('write EPIPE'), {
          code: 'EPIPE',
        }),
      ),
    ).toBe(true);
    expect(
      isCliPipeClosureError(
        Object.assign(new Error('stream destroyed'), {
          code: 'ERR_STREAM_DESTROYED',
        }),
      ),
    ).toBe(true);
    expect(isCliPipeClosureError(new Error('disk full'))).toBe(false);
  });
});
