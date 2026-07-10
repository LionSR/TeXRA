// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { isCliPipeClosureError, NdjsonStdoutSink } from '@cli/runtime/logSinks';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';

function createStdoutStub() {
  const lines: string[] = [];
  return {
    lines,
    stdout: {
      destroyed: false,
      write: vi.fn((line: string) => {
        lines.push(line);
        return true;
      }),
      once: vi.fn(),
      off: vi.fn(),
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
    const { lines, stdout } = createStdoutStub();
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
    await sink.flush();

    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      'log',
      'progress',
    ]);
  });
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
