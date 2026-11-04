/**
 * `defineTool`'s one catch: what a tool body's failure becomes for the model,
 * and what the log keeps of it.
 */
import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect } from 'vitest';

import { defineTool } from '@texra-ai/harness';
import { effectDiagnosticsLayer, setLogSink } from '@texra-ai/harness/node';

import { captureLogEntries } from '@test/support/logSinkCapture';

describe('defineTool', () => {
  afterEach(() => {
    setLogSink(null);
  });

  // Failure mode: a bug inside a tool's body (a defect, not the tool's own
  // `ToolError`) reached the model as a failed call and nothing else: the
  // cause was in no log, so the bug read as the model's mistake.
  it.live('logs a defect inside a tool body before the model reads it', () =>
    Effect.gen(function* () {
      const capture = captureLogEntries();
      const tool = defineTool({
        name: 'crashes',
        description: 'A tool whose body has a bug.',
        schema: Schema.Struct({}),
        execute: () => Effect.die(new TypeError('x is not a function')),
      });

      const result = yield* tool
        .call({})
        .pipe(Effect.provide(effectDiagnosticsLayer('Trace')));

      expect(result).toMatchObject({
        status: 'error',
        error: 'x is not a function',
      });
      expect(capture.has('WARN', 'tools', 'crashed')).toBe(true);
    }),
  );
});
