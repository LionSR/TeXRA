import { it } from '@effect/vitest';
import { Effect, ManagedRuntime } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { setLogSink } from '@logger/logSink';
import { withForkFailureReporting } from '@platform/processRuntime';

import {
  captureLogEntries,
  type LogCapture,
} from '@test/support/logSinkCapture';

const REPORT_MESSAGE = 'Unhandled failure in forked fiber';

function makeReportingRuntime() {
  return Effect.acquireRelease(
    Effect.sync(() =>
      withForkFailureReporting(
        ManagedRuntime.make(effectDiagnosticsLayer('Trace')),
      ),
    ),
    (runtime) => Effect.promise(() => runtime.dispose()),
  );
}

/** The reporter fiber logs on a later microtask than the exit it observes. */
function waitForErrorEntry(capture: LogCapture) {
  return Effect.gen(function* () {
    for (let i = 0; i < 100 && capture.at('ERROR').length === 0; i++) {
      yield* Effect.sleep(10);
    }
  });
}

describe('withForkFailureReporting', () => {
  afterEach(() => {
    setLogSink(null);
  });

  it.live('reports a defect in a forked fiber', () =>
    Effect.gen(function* () {
      const capture = captureLogEntries();
      const runtime = yield* makeReportingRuntime();

      runtime.runFork(Effect.die(new Error('boom')));
      yield* waitForErrorEntry(capture);

      expect(capture.at('ERROR')).toHaveLength(1);
      expect(capture.at('ERROR')[0]?.message).toBe(REPORT_MESSAGE);
    }),
  );

  it.live('reports an unhandled typed failure in a forked fiber', () =>
    Effect.gen(function* () {
      const capture = captureLogEntries();
      const runtime = yield* makeReportingRuntime();

      runtime.runFork(Effect.fail('refused'));
      yield* waitForErrorEntry(capture);

      expect(capture.at('ERROR')).toHaveLength(1);
      expect(capture.at('ERROR')[0]?.message).toBe(REPORT_MESSAGE);
    }),
  );

  it.live('stays silent for a success and an interrupts-only exit', () =>
    Effect.gen(function* () {
      const capture = captureLogEntries();
      const runtime = yield* makeReportingRuntime();

      runtime.runFork(Effect.void);
      runtime.runFork(Effect.interrupt);
      yield* Effect.sleep(50);

      expect(capture.entries()).toHaveLength(0);
    }),
  );
});
