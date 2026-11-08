// Node imports
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { assert, expect } from 'vitest';

// Local imports
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { FakeHost } from '@test/support/testKernel';
import { runCompileCheck } from '@texra/agent/output/compileCheck';

// Local file imports
import {
  compileContext,
  compileFsLayer,
  latexHost,
  outputFile,
} from './compileCheckTestUtils';

const runId = Schema.decodeUnknownSync(RunIdSchema)('c0e0e1');

// No file is seeded at the tex path, so the output read fails NotFound
// before the compile is ever invoked.
layer(latexHost({}), { excludeTestServices: true })('runCompileCheck', (it) => {
  it.effect(
    'counts a per-file exception as a failure, never a silent skip',
    () =>
      Effect.gen(function* () {
        const { roots } = yield* FakeHost;
        const result = yield* runCompileCheck(compileContext(roots, runId), 0, [
          outputFile(roots, runId, path.join('r0', 'main.tex'), 'main.tex', 0),
        ]);

        assert(result._tag === 'checked');
        const { failures } = result;
        expect(failures).toHaveLength(1);
        expect(failures[0].displayName).toBe('main.tex');

        // The synthetic excerpt is persisted like a real failure so it stays
        // discoverable on disk, not just in-memory.
        const persisted = yield* Effect.promise(() =>
          readFile(failures[0].log.absolutePath, 'utf-8'),
        );
        expect(persisted).toContain('Compile check errored for main.tex');
      }).pipe(Effect.provide(compileFsLayer)),
  );
});
