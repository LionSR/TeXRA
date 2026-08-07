// Node imports
import { PassThrough } from 'node:stream';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  askCliQuestion,
  isCliPipeClosureError,
  NdjsonStdoutSink,
} from '@cli/runtime/logSinks';
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
      usable: true,
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

  it('writes nothing once the target reports itself unusable', async () => {
    const { lines, stdout } = createStdoutStub();
    stdout.usable = false;
    const sink = new NdjsonStdoutSink(stdout);

    sink.writeRecord({ kind: 'version', version: '1.0.0' });
    await sink.flush();

    expect(lines).toEqual([]);
    expect(stdout.write).not.toHaveBeenCalled();
  });
});

describe('CLI pipe errors', () => {
  function errorWithCode(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
  }

  it('recognizes pipe closure errors as non-fatal output events', () => {
    expect(isCliPipeClosureError(errorWithCode('write EPIPE', 'EPIPE'))).toBe(
      true,
    );
    expect(
      isCliPipeClosureError(
        errorWithCode('stream destroyed', 'ERR_STREAM_DESTROYED'),
      ),
    ).toBe(true);
    expect(isCliPipeClosureError(new Error('disk full'))).toBe(false);
  });
});

describe('CLI questions', () => {
  it('acquires stdin ownership before waiting for an answer', async () => {
    const input = Object.assign(new PassThrough(), { ref: vi.fn() });
    const output = new PassThrough();

    const answer = askCliQuestion('Choose: ', input, output);
    input.end('continue\n');

    await expect(answer).resolves.toBe('continue');
    expect(input.ref).toHaveBeenCalledOnce();
  });
});
