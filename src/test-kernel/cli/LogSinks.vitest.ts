// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { NdjsonStdoutSink, setCliLogRuntime } from '@cli/runtime/logSinks';
import { testRuntime } from '@test/support/testProcessRuntime';

// The sink queues each record on a FIFO lane of the runtime its composition
// root hands it; here that root is this suite.
beforeEach(() => {
  setCliLogRuntime(testRuntime());
});

afterEach(() => {
  setCliLogRuntime(null);
});

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
  it.effect('preserves records added while stdout is backpressured', () =>
    Effect.gen(function* () {
      const { emit, lines, stdout } = createStdoutStub([false, true]);
      const sink = new NdjsonStdoutSink(stdout);

      sink.writeRecord({ kind: 'version', version: '1.0.0' });
      sink.writeRecord({ kind: 'doctor-summary', ok: true });
      emit('drain');
      yield* sink.flush();

      expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
        'version',
        'doctor-summary',
      ]);
    }),
  );
});
