// Node imports
import path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { computeOutputDiffStats } from '@agent/implementations/flows/reflection/output/diffComputation';
import { assignByContentSimilarity } from '@agent/implementations/flows/reflection/output/extraction/contentSimilarity';
import {
  createOutputState,
  ensureRoundData,
} from '@agent/implementations/flows/reflection/output/outputState';
import type { RoundFileMapping } from '@agent/implementations/flows/reflection/output/types';
import { fileLocationDisplayPath, type RunId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { computeAndWriteWorkflowDiffs } from '@tools/delegation/subagentResults';
import {
  computeLineChangeSummary,
  firstChangedLine,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createExternalLocation } from '@utils/files/fileLocation';
import { getRunDir } from '@utils/files/runStorageFs';
import { unifiedDiffText } from '@utils/text/unifiedDiff';

function installFakePlatform(
  files: Record<string, string> = {},
): Promise<void> {
  return installPlatform({
    files,
    storagePath: '/workspace/.texra/storage',
    workspacePath: '/workspace',
  });
}

describe('shared text-diff caller fixtures', () => {
  it.effect('preserves subagent line-mode diff files', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installFakePlatform({
          '/workspace/original.tex': 'one\ntwo\nthree\n',
          '/workspace/out/section/paper.tex': 'one\nTWO\nthree\nfour\n',
        }),
      );
      const runId = 'abcdef' as RunId;

      const result = yield* Effect.tryPromise(() =>
        computeAndWriteWorkflowDiffs(runId, [
          {
            round: 0,
            relativePath: 'section/paper.tex',
            absolutePath: '/workspace/out/section/paper.tex',
            location: 'workspace',
            originalPath: '/workspace/original.tex',
            added: 2,
            removed: 1,
          },
        ]),
      );

      expect(result.get('/workspace/out/section/paper.tex')).toEqual({
        diffRelPath: 'diffs/section_paper.tex.diff',
        largeChange: true,
      });
      expect(
        yield* Effect.tryPromise(() =>
          AbsoluteFS.read(
            path.join(getRunDir(runId), 'diffs/section_paper.tex.diff'),
          ),
        ),
      ).toBe('@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four');
    }),
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
        const patch = unifiedDiffText(original, final);
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
            nativeToolTestLayer({ workingDirectory: '/workspace' }),
          ),
        );

        expect(writeResult).toEqual({
          appliedContent: 'alpha\nBETA\nomega\nlocal\n',
          baseContent: 'alpha\nbeta\nomega\nlocal\n',
        });
        expect(
          yield* Effect.tryPromise(() =>
            AbsoluteFS.read('/workspace/paper.tex'),
          ),
        ).toBe('alpha\nBETA\nomega\nlocal\n');
      }),
  );
});
