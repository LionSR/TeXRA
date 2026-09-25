// Node imports
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { computeOutputDiffStats } from '@agent/output/diffComputation';
import { assignByContentSimilarity } from '@agent/output/extraction/contentSimilarity';
import { createOutputState, ensureRoundData } from '@agent/output/outputState';
import type { RoundFileMapping } from '@agent/output/types';
import {
  fileLocationDisplayPath,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { buildSubagentResult } from '@tools/delegation/subagentResults';
import {
  computeLineChangeSummary,
  firstChangedLine,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { createExternalLocation } from '@utils/files/fileLocation';
import { runDirUnder } from '@utils/files/runStorageFs';
import { unifiedDiffText } from '@utils/text/unifiedDiff';

function installFakePlatform(
  files: Record<string, string> = {},
): Promise<void> {
  return installPlatform({
    files,
    storagePath: fakePath('workspace/.texra/storage'),
    workspacePath: fakePath('workspace'),
  });
}

const tempDirs = useTempDirs();

describe('shared text-diff caller fixtures', () => {
  // The writer reads and writes through the process filesystem, so this
  // fixture works on real files under a temp root of its own.
  it.effect('preserves subagent line-mode diff files', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* Effect.promise(() =>
        makeTempDir('texra-subagent-diffs-', tempDirs),
      );
      const storageRoot = path.join(root, 'storage');
      const originalPath = path.join(root, 'original.tex');
      const absolutePath = path.join(root, 'out', 'section', 'paper.tex');
      yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
      yield* fs.writeFileString(originalPath, 'one\ntwo\nthree\n');
      yield* fs.writeFileString(absolutePath, 'one\nTWO\nthree\nfour\n');

      const runId = 'abcdef' as RunId;
      const meta = yield* buildSubagentResult(
        runId,
        'workflow-subagent',
        {
          category: 'workflow',
          outputs: [
            {
              round: 0,
              relativePath: 'section/paper.tex',
              absolutePath,
              location: 'workspace',
              originalPath,
              added: 2,
              removed: 1,
            },
          ],
          compileFailures: [],
          diffs: [],
        },
        { startedAt: Date.now(), storageRoot },
      );

      if (meta.output.category !== 'workflow') {
        throw new Error('Expected a workflow subagent result.');
      }
      expect(meta.output.diffs).toEqual([
        {
          path: absolutePath,
          diffRelPath: 'diffs/section_paper.tex.diff',
          largeChange: true,
        },
      ]);
      expect(
        yield* fs.readFileString(
          path.join(
            runDirUnder(storageRoot, runId),
            'diffs/section_paper.tex.diff',
          ),
        ),
      ).toBe('@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.effect(
    'preserves tool-edit approval diff summaries and patch application',
    () =>
      Effect.gen(function* () {
        const original = 'alpha\nbeta\nomega\n';
        const final = 'alpha\nBETA\nomega\n';

        expect(computeLineChangeSummary(original, final)).toEqual({
          added: 1,
          removed: 1,
        });
        expect(
          firstChangedLine(
            'alpha\nbeta\nomega\n',
            'alpha\ninsert\nbeta\nomega\n',
          ),
        ).toBe(1);
        const patch = unifiedDiffText(original, final).text;
        expect(patch).toContain('-beta');
        expect(patch).toContain('+BETA');

        yield* Effect.tryPromise(() =>
          installFakePlatform({
            '/workspace/paper.tex': 'alpha\nbeta\nomega\nlocal\n',
          }),
        );
        const writeResult = yield* writeApprovedContent(
          'paper.tex',
          original,
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );

        expect(writeResult).toEqual({
          appliedContent: 'alpha\nBETA\nomega\nlocal\n',
          baseContent: 'alpha\nbeta\nomega\nlocal\n',
        });
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('alpha\nBETA\nomega\nlocal\n');
      }),
  );
});
