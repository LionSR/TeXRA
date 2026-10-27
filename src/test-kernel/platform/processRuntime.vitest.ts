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

  it.live.each([
    ['a defect', Effect.die(new Error('boom'))],
    ['an unhandled typed failure', Effect.fail('refused')],
  ] as const)('reports %s in a forked fiber', ([, program]) =>
    Effect.gen(function* () {
      const capture = captureLogEntries();
      const runtime = yield* makeReportingRuntime();

      runtime.runFork(program);
      yield* waitForErrorEntry(capture);

      expect(capture.at('ERROR')).toHaveLength(1);
      expect(capture.at('ERROR')[0]?.message).toBe(REPORT_MESSAGE);
    }),
  );
});
