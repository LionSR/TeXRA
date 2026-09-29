// Node imports
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { buildSubagentResult } from '@agent/runtime/subagentResults';
import { type RunId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import {
  approvedWriteConflict,
  writeApprovedContent,
} from '@tools/approval/approvedWrite';
import {
  computeLineChangeSummary,
  firstChangedLine,
} from '@tools/approval/toolEditApproval';
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

        // A concurrent change to the approved hunk is a conflict, never an
        // overwrite of that change with the approved content.
        yield* Effect.tryPromise(() =>
          installFakePlatform({
            '/workspace/paper.tex': 'rewritten\nby another\nwriter\n',
          }),
        );
        const conflict = yield* approvedWriteConflict(
          'paper.tex',
          original,
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(conflict?.message).toContain('changed on disk');
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('rewritten\nby another\nwriter\n');

        // A concurrent edit of the same line is a conflict even where the
        // approved change could still be placed fuzzily around it.
        yield* Effect.tryPromise(() =>
          installFakePlatform({
            '/workspace/paper.tex': 'title\nmode=green\nend\n',
          }),
        );
        const overlapping = yield* approvedWriteConflict(
          'paper.tex',
          'title\nmode=red\nend\n',
          'title\nmode=blue\nend\n',
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(overlapping).toBeDefined();
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('title\nmode=green\nend\n');

        // A concurrent change to the edited copy of a duplicated block is a
        // conflict; the edit never moves onto the untouched duplicate.
        const block = 'a\nb\nc\nx\nd\ne\nf\n';
        yield* Effect.tryPromise(() =>
          installFakePlatform({
            '/workspace/paper.tex': `a\nb\nc\ny\nd\ne\nf\n${block}`,
          }),
        );
        const duplicated = yield* approvedWriteConflict(
          'paper.tex',
          `${block}${block}`,
          `a\nb\nc\nX\nd\ne\nf\n${block}`,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(duplicated).toBeDefined();

        // An insertion among equal lines has no one position, so a
        // concurrent change among them is a conflict, not a guess.
        yield* Effect.tryPromise(() =>
          installFakePlatform({ '/workspace/paper.tex': 'a\nX\na\n' }),
        );
        const ambiguous = yield* approvedWriteConflict(
          'paper.tex',
          'a\na\n',
          'a\na\na\n',
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(ambiguous).toBeDefined();

        // So is a deletion, even of a file that was empty when proposed: the
        // approved content does not recreate it.
        yield* Effect.tryPromise(() => installFakePlatform({}));
        const deleted = yield* approvedWriteConflict(
          'paper.tex',
          '',
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(deleted).toBeDefined();
        expect(
          yield* Effect.exit(
            Effect.tryPromise(() => readFile(fakePath('workspace/paper.tex'))),
          ),
        ).toMatchObject({ _tag: 'Failure' });

        // And a file created meanwhile at a path that was absent is not
        // merged into.
        yield* Effect.tryPromise(() =>
          installFakePlatform({ '/workspace/paper.tex': 'theirs\n' }),
        );
        const created = yield* approvedWriteConflict(
          'paper.tex',
          null,
          final,
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({ workingDirectory: fakePath('workspace') }),
          ),
        );
        expect(created).toBeDefined();
        expect(
          yield* Effect.tryPromise(() =>
            readFile(fakePath('workspace/paper.tex'), 'utf-8'),
          ),
        ).toBe('theirs\n');
      }),
  );
});
