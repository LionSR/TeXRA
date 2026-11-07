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
import { harnessBuiltins } from '@texra-ai/harness/plugins';

describe('Sessions.layer', () => {
  it.live("logs through the embedder's own logger", () => {
    const lines: string[] = [];
    const captured = Logger.make(({ message }) => {
      for (const part of Array.isArray(message) ? message : [message])
        lines.push(String(part));
    });
    const dir = mkdtempSync(join(tmpdir(), 'texra-embedder-log-'));
    const platform = nodePlatform({
      agentsDir: join(dir, 'agents'),
      storageDir: join(dir, 'storage'),
      workspaceDir: dir,
    });
    return Effect.gen(function* () {
      yield* (yield* Sessions).open(platform.roots);
      expect(lines.some((line) => /Loaded \d+ agents/.test(line))).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
      Effect.provide(Logger.layer([captured])),
      // The catalog's load time is a debug line.
      Effect.provide(Layer.succeed(References.MinimumLogLevel)('Debug')),
    );
  });
});
