// Node imports
import { PassThrough } from 'node:stream';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import {
  askCliQuestion,
  NdjsonStdoutSink,
  setCliLogRuntime,
} from '@cli/runtime/logSinks';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { testRuntime } from '@test/support/testProcessRuntime';

// The sink queues each record on a FIFO lane of the runtime its composition
// root hands it; here that root is this suite. Without one the sink writes
// straight through, which is the no-runtime edge its own tests cover.
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
  it.effect(
    'flushes consecutive synchronous writes without stranding the queue',
    () =>
      Effect.gen(function* () {
        const { lines, stdout } = createStdoutStub();
        const sink = new NdjsonStdoutSink(stdout);
        const records: readonly CliNdjsonRecord[] = [
          { kind: 'version', version: '1.0.0' },
          { kind: 'doctor-summary', ok: true },
        ];

        sink.writeRecord(records[0]);
        sink.writeRecord(records[1]);
        yield* sink.flush();

        // The sink stamps the contract version last, so `kind` stays the first key.
        expect(lines.map((line) => JSON.parse(line))).toEqual(
          records.map((record) => ({ ...record, contract: 2 })),
        );
      }),
  );

  it.effect('preserves order across logger and public-record writes', () =>
    Effect.gen(function* () {
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
        event: 'status',
        payload: { aggregateId: '["run","run-1"]', phase: 'running' },
      });
      emit('drain');
      yield* sink.flush();

      expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
        'log',
        'progress',
      ]);
    }),
  );

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

  it.effect.each(['error', 'close'] as const)(
    'discards queued and later records after stdout %s',
    (event) =>
      Effect.gen(function* () {
        const { emit, lines, stdout } = createStdoutStub([false]);
        const sink = new NdjsonStdoutSink(stdout);

        sink.writeRecord({ kind: 'version', version: '1.0.0' });
        sink.writeRecord({ kind: 'doctor-summary', ok: true });
        emit(event);
        sink.writeRecord({ kind: 'auth-status', authenticated: false });
        yield* sink.flush();

        expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['version']);
      }),
  );

  it.effect('writes nothing once the target reports itself unusable', () =>
    Effect.gen(function* () {
      const { lines, stdout } = createStdoutStub();
      stdout.usable = false;
      const sink = new NdjsonStdoutSink(stdout);

      sink.writeRecord({ kind: 'version', version: '1.0.0' });
      yield* sink.flush();

      expect(lines).toEqual([]);
      expect(stdout.write).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'resolves flush when a write throws instead of waiting for drain',
    () =>
      Effect.gen(function* () {
        const stdout = {
          usable: true,
          write: vi.fn((): boolean => {
            throw new Error('write failed');
          }),
          once: vi.fn(),
          off: vi.fn(),
        };
        const sink = new NdjsonStdoutSink(stdout);

        sink.writeRecord({ kind: 'version', version: '1.0.0' });
        expect(yield* sink.flush()).toBeUndefined();
        expect(stdout.once).not.toHaveBeenCalled();
      }),
  );
});

describe('CLI questions', () => {
  it.effect('acquires stdin ownership before waiting for an answer', () =>
    Effect.gen(function* () {
      const input = Object.assign(new PassThrough(), { ref: vi.fn() });
      const output = new PassThrough();

      // Forked, the prompt's acquire opens the readline interface and its
      // listener is attached before this fiber ends the input.
      const asking = yield* Effect.forkChild(
        askCliQuestion('Choose: ', { input, output }),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      );
      input.end('continue\n');

      expect(yield* Fiber.join(asking)).toBe('continue');
      expect(input.ref).toHaveBeenCalledOnce();
    }),
  );
});
