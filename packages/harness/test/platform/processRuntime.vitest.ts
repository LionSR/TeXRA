import { it } from '@effect/vitest';
import { Effect, ManagedRuntime, Schedule } from 'effect';
import { describe, expect } from 'vitest';

import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import { effectDiagnosticsLayer } from '@texra-ai/harness/node';

import { captureLogEntries } from '@test/support/logSinkCapture';

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

describe('withForkFailureReporting', () => {
  it.live.each([
    ['an unhandled typed failure', Effect.fail('refused')],
  ] as const)('reports %s in a forked fiber', ([, program]) =>
    Effect.gen(function* () {
      const capture = yield* captureLogEntries;
      const runtime = yield* makeReportingRuntime();

      runtime.runFork(program);
      // The reporter fiber logs on a later microtask than the exit it
      // observes.
      yield* Effect.sync(() => capture.at('ERROR').length).pipe(
        Effect.repeat({
          schedule: Schedule.spaced('10 millis'),
          until: (errors) => errors > 0,
        }),
        Effect.timeout('1 second'),
      );

      expect(capture.at('ERROR')).toHaveLength(1);
      expect(capture.at('ERROR')[0]?.message).toBe(REPORT_MESSAGE);
    }),
  );
});
