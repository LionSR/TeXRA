// Node imports
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, it as vitestIt } from 'vitest';

// Local imports
import { runPackSingle } from '@housekeeping/pack';
import { workflowOutputCopyStem } from '@shared/constants/workflowOutput';
import { pathExists, rootedFsLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

describe('Save-as-copy stem and workspace pack', () => {
  const tempDirs = useTempDirs();
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await makeTempDir(
      'texra-legacy-workflow-output-',
      tempDirs,
    );
  });

  vitestIt.each([
    ['builtInWorkflow:write-polish', 'polish'],
    ['custom:alpha_beta', 'alpha'],
    ['remote:alpha-beta', 'alpha'],
    ['vendor:alpha_beta', 'vendor:alpha'],
  ])('preserves the agent chunk in the stem for %s', (agent, expected) => {
    expect(
      workflowOutputCopyStem({
        base: 'paper',
        agent,
        model: 'gpt-4',
        round: 0,
      }),
    ).toBe(`paper_${expected}_r0_gpt-4`);
  });

  it.live(
    "packs the source's own files and leaves Save-as-copy files and the source's .bib/.bak alone",
    () =>
      Effect.gen(function* () {
        const saveAsCopy = 'paper_polish_r0_gpt-4.tex';
        yield* Effect.promise(() =>
          Promise.all(
            [
              'paper.tex',
              'paper.pdf',
              'paper.bib',
              'paper.bak1',
              'paper.aux',
              saveAsCopy,
            ].map((name) =>
              writeFile(path.join(workspacePath, name), 'fixture'),
            ),
          ),
        );

        // The pack takes its workspace from context: the rooted view over
        // this test's temp root, with no ambient platform installed.
        const result = yield* runPackSingle(
          'gpt-4',
          'paper.tex',
          'custom:polish_long',
        ).pipe(
          Effect.provide(
            rootedFsLayer({
              workspace: workspacePath,
              storage: path.join(workspacePath, '.texra'),
            }),
          ),
        );

        expect(result).toMatchObject({ status: 'success' });
        const outputFolderRelative =
          result.status === 'success' ? result.outputFolder : undefined;
        expect(outputFolderRelative).toBeDefined();
        const outputFolder = path.join(
          workspacePath,
          outputFolderRelative ?? '',
        );
        expect(path.basename(outputFolderRelative ?? '')).not.toContain(':');

        const exists = (target: string) =>
          Effect.promise(() => pathExists(target));
        expect(yield* exists(path.join(outputFolder, 'paper.pdf'))).toBe(true);
        for (const kept of ['paper.bib', 'paper.bak1', saveAsCopy]) {
          expect(yield* exists(path.join(workspacePath, kept))).toBe(true);
        }
        expect(yield* exists(path.join(outputFolder, saveAsCopy))).toBe(false);
        expect(yield* exists(path.join(workspacePath, 'paper.aux'))).toBe(
          false,
        );
      }),
  );

  it.live(
    'packs a picker selection outside the workspace next to the selection',
    () =>
      Effect.gen(function* () {
        // The picker keeps an out-of-workspace selection absolute; the whole
        // pack happens where the selection is, as the old facade did.
        const externalDir = yield* Effect.promise(() =>
          makeTempDir('texra-legacy-workflow-external-', tempDirs),
        );
        yield* Effect.promise(() =>
          Promise.all(
            ['notes.tex', 'notes.pdf', 'notes.aux'].map((name) =>
              writeFile(path.join(externalDir, name), 'fixture'),
            ),
          ),
        );

        const result = yield* runPackSingle(
          'gpt-4',
          path.join(externalDir, 'notes.tex'),
          'custom:polish',
        ).pipe(
          Effect.provide(
            rootedFsLayer({
              workspace: workspacePath,
              storage: path.join(workspacePath, '.texra'),
            }),
          ),
        );

        expect(result).toMatchObject({ status: 'success' });
        const outputFolder =
          result.status === 'success' ? (result.outputFolder ?? '') : '';
        expect(path.dirname(outputFolder)).toBe(
          path.join(externalDir, 'History'),
        );
        const exists = (target: string) =>
          Effect.promise(() => pathExists(target));
        expect(yield* exists(path.join(outputFolder, 'notes.pdf'))).toBe(true);
        expect(yield* exists(path.join(workspacePath, 'History'))).toBe(false);
        expect(yield* exists(path.join(externalDir, 'notes.pdf'))).toBe(true);
        expect(yield* exists(path.join(externalDir, 'notes.aux'))).toBe(false);
      }),
  );
});
