/**
 * The embedder's composition, `Sessions.layer` (`processLayer.ts`), over a
 * real `nodePlatform` in a temporary directory.
 *
 * Failure modes:
 * - the harness replaces the embedder's Effect loggers with its own console
 *   sink, so its log lines reach the process's stdout and never the logger
 *   layer the embedder's program provides.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Layer, Logger, References } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/builtins';
import { HARNESS_APP } from '@test/support/FakePlatform';

describe('Sessions.layer', () => {
  it.live("logs through the embedder's own logger", () => {
    const lines: string[] = [];
    const captured = Logger.make(({ message }) => {
      for (const part of Array.isArray(message) ? message : [message])
        lines.push(String(part));
    });
    const dir = mkdtempSync(join(tmpdir(), 'texra-embedder-log-'));
    const platform = nodePlatform({
      storageDir: join(dir, 'storage'),
      workspaceDir: dir,
    });
    return Effect.gen(function* () {
      yield* (yield* Sessions).open(platform.roots);
      expect(lines.some((line) => line.startsWith('First install:'))).toBe(
        true,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({
          platform,
          plugins: harnessBuiltins,
          client: HARNESS_APP.client,
        }).pipe(
          Layer.provideMerge(
            Layer.merge(
              Logger.layer([captured]),
              // The plugin switches' first-install line is a debug line.
              Layer.succeed(References.MinimumLogLevel)('Debug'),
            ),
          ),
        ),
      ),
    );
  });
});
